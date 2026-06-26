"""Dynadot account CRUD + sync. Mirrors the shape of the CF account endpoints
so the frontend can manage both registrars with one mental model."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user, require_admin, require_delete_token
from app.db.session import get_db
from app.models.models import DynadotAccount, Team, User
from app.services import dynadot as dynadot_svc
from app.services.audit import log_action
from app.api.teams import _save_creds_to_passwords

router = APIRouter(prefix="/api/dynadot", tags=["dynadot"])


class DynadotIn(BaseModel):
    name: str
    api_key: str


class DynadotUpdate(BaseModel):
    name: Optional[str] = None
    api_key: Optional[str] = None


class DynadotOut(BaseModel):
    id: int
    team_id: int
    name: str
    is_active: bool
    last_synced_at: Optional[datetime] = None
    last_error: Optional[str] = None
    domains_count: Optional[int] = None
    created_by_user_id: Optional[int] = None
    created_by_username: Optional[str] = None

    class Config:
        from_attributes = True


async def _dyn_to_out(acc: DynadotAccount, db: AsyncSession) -> DynadotOut:
    out = DynadotOut.model_validate(acc)
    if acc.created_by_user_id:
        u = await db.get(User, acc.created_by_user_id)
        out.created_by_username = u.username if u else None
    return out


@router.get("/accounts", response_model=list[DynadotOut])
async def list_all(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = (await db.execute(
        select(DynadotAccount).order_by(DynadotAccount.team_id, DynadotAccount.name)
    )).scalars().all()
    return [await _dyn_to_out(a, db) for a in rows]


@router.post("/teams/{team_id}/accounts", response_model=DynadotOut,
             dependencies=[Depends(require_admin)])
async def create(team_id: int, data: DynadotIn, db: AsyncSession = Depends(get_db),
                 user: User = Depends(get_current_user)):
    team = await db.get(Team, team_id)
    if not team:
        raise HTTPException(404, "Team not found")
    ok, err = await dynadot_svc.verify_key(data.api_key.strip())
    acc = DynadotAccount(
        team_id=team_id,
        name=data.name.strip(),
        api_key=data.api_key.strip(),
        is_active=ok,
        last_error=None if ok else err,
        created_by_user_id=user.id,
    )
    db.add(acc)
    log_action(db, "dynadot_account_add", user=user, target=data.name.strip(),
               details={"team": team.name, "valid": ok, "error": err})
    await _save_creds_to_passwords(
        db, user, provider="Dynadot",
        label=f"Dynadot: {data.name.strip()} [{team.name}]",
        login=None, secret=data.api_key.strip(),
        url="https://www.dynadot.com",
        tags="auto,dynadot,api",
    )
    await db.flush()
    await db.refresh(acc)
    return acc


@router.patch("/accounts/{acc_id}", response_model=DynadotOut,
              dependencies=[Depends(require_admin)])
async def update(acc_id: int, data: DynadotUpdate, db: AsyncSession = Depends(get_db),
                  user: User = Depends(get_current_user)):
    acc = await db.get(DynadotAccount, acc_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    if data.name is not None and data.name.strip():
        acc.name = data.name.strip()
    if data.api_key is not None and data.api_key.strip():
        new_key = data.api_key.strip()
        ok, err = await dynadot_svc.verify_key(new_key)
        acc.api_key = new_key
        acc.is_active = ok
        acc.last_error = None if ok else err
        team = await db.get(Team, acc.team_id)
        await _save_creds_to_passwords(
            db, user, provider="Dynadot",
            label=f"Dynadot: {acc.name} [{team.name if team else '—'}]",
            login=None, secret=new_key,
            url="https://www.dynadot.com",
            tags="auto,dynadot,api",
        )
    await db.flush()
    await db.refresh(acc)
    await db.commit()
    return acc


@router.delete("/accounts/{acc_id}", dependencies=[Depends(require_delete_token)])
async def delete(acc_id: int, db: AsyncSession = Depends(get_db),
                  user: User = Depends(get_current_user)):
    acc = await db.get(DynadotAccount, acc_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    log_action(db, "dynadot_account_delete", user=user, target=acc.name)
    await db.delete(acc)
    return {"ok": True}


@router.post("/accounts/{acc_id}/sync")
async def sync(acc_id: int, db: AsyncSession = Depends(get_db),
               user: User = Depends(get_current_user)):
    acc = await db.get(DynadotAccount, acc_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    try:
        domains = await dynadot_svc.list_domains(acc.api_key)
    except Exception as e:
        acc.is_active = False
        acc.last_error = str(e)[:500]
        log_action(db, "dynadot_sync_failed", user=user, target=acc.name,
                   details={"error": str(e)[:200]})
        await db.flush()
        await db.commit()
        raise HTTPException(502, f"Dynadot error: {e}")
    acc.is_active = True
    acc.last_error = None
    acc.domains_count = len(domains)
    acc.last_synced_at = datetime.now(timezone.utc)
    log_action(db, "dynadot_sync", user=user, target=acc.name,
               details={"domains_count": len(domains)})
    await db.flush()
    await db.commit()
    return {"ok": True, "domains_count": len(domains)}
