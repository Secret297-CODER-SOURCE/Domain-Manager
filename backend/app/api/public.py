"""Public, no-auth domain lookup + admin codeword management.

The `/check-domain` endpoint is intentionally rate-limit-free here — it's
designed to be hit from a public landing page by frontenders who only need
"is this our domain?" yes/no. Provide the configured codeword to escalate
the answer to include the owning team.
"""
from __future__ import annotations
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_admin
from app.db.session import get_db
from app.models.models import (
    BackupConfig, Domain, CloudflareAccount, Team, User,
)
from app.services.audit import log_action


router = APIRouter(tags=["public"])


# ── Public: domain check ─────────────────────────────────────────────────

class CheckResult(BaseModel):
    domain: str
    owned: bool
    team: Optional[str] = None
    cf_account: Optional[str] = None
    status: Optional[str] = None
    detail: Optional[str] = None  # error/info string for the UI


def _norm(name: str) -> str:
    n = name.strip().lower()
    for prefix in ("http://", "https://"):
        if n.startswith(prefix):
            n = n[len(prefix):]
    n = n.split("/", 1)[0]
    if n.startswith("www."):
        n = n[4:]
    return n


@router.get("/api/public/check-domain", response_model=CheckResult)
async def check_domain(
    name: str = Query(..., min_length=3, max_length=255),
    codeword: Optional[str] = Query(None, max_length=128),
    db: AsyncSession = Depends(get_db),
):
    domain_name = _norm(name)
    if "." not in domain_name or len(domain_name) < 4:
        raise HTTPException(400, "Invalid domain")

    row = (await db.execute(
        select(Domain, CloudflareAccount, Team)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .outerjoin(Team, CloudflareAccount.team_id == Team.id)
        .where(Domain.name == domain_name)
    )).first()

    out = CheckResult(domain=domain_name, owned=row is not None)
    if not row:
        return out

    domain, account, team = row
    out.status = str(domain.zone_status).split(".")[-1]

    # Front-end mode: reveal team only when correct codeword
    if codeword is not None:
        cfg = (await db.execute(
            select(BackupConfig).where(BackupConfig.id == 1)
        )).scalar_one_or_none()
        stored = (cfg.frontend_codeword or "").strip() if cfg else ""
        if stored and codeword.strip() == stored:
            out.team = team.name if team else None
            out.cf_account = account.name
        else:
            out.detail = "wrong codeword"
    return out


# ── Admin: get / set codeword ────────────────────────────────────────────

class CodewordIn(BaseModel):
    codeword: Optional[str] = None  # null/empty disables front-end mode


class CodewordOut(BaseModel):
    codeword: Optional[str] = None
    is_set: bool


def _get_or_create_cfg(db: AsyncSession) -> "_GetOrCreate":
    """Helper coroutine returns the BackupConfig singleton (id=1)."""
    raise NotImplementedError  # placeholder for type — real impl below


async def _cfg(db: AsyncSession) -> BackupConfig:
    cfg = (await db.execute(select(BackupConfig).where(BackupConfig.id == 1))).scalar_one_or_none()
    if not cfg:
        cfg = BackupConfig(id=1)
        db.add(cfg)
        await db.flush()
    return cfg


@router.get("/api/admin/frontend-codeword", response_model=CodewordOut,
            dependencies=[Depends(require_admin)])
async def get_codeword(db: AsyncSession = Depends(get_db)):
    cfg = await _cfg(db)
    cw = (cfg.frontend_codeword or "").strip()
    return CodewordOut(codeword=cw or None, is_set=bool(cw))


@router.put("/api/admin/frontend-codeword", response_model=CodewordOut,
            dependencies=[Depends(require_admin)])
async def set_codeword(data: CodewordIn, db: AsyncSession = Depends(get_db),
                        user: User = Depends(require_admin)):
    cfg = await _cfg(db)
    new = (data.codeword or "").strip() or None
    cfg.frontend_codeword = new
    log_action(db, "frontend_codeword_set", user=user,
               details={"is_set": bool(new), "length": len(new) if new else 0})
    await db.commit()
    return CodewordOut(codeword=new, is_set=bool(new))
