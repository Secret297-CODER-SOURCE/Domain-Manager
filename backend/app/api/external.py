"""Service-to-service API for external integrations — currently BurnCheck:
pulling a team's Cloudflare accounts by team code, pushing Siberguvenlik
confirmations, and pulling per-domain status for reconciliation.

Gated by X-API-Key, not a user JWT (see require_external_api_key). Two key
kinds are accepted: the static shared EXTERNAL_API_KEY (unrestricted, legacy)
or a per-team key from burncheck_instances (see security.py) — the latter
is restricted to its own team's {code} on every route below.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import require_external_api_key
from app.db.session import get_db
from app.models.models import BurncheckInstance, Team, CloudflareAccount, Domain

router = APIRouter(
    prefix="/api/external",
    tags=["external"],
)


def _check_team_access(instance: BurncheckInstance | None, team: Team) -> None:
    """A per-instance key may only touch the team it was issued to. The
    shared EXTERNAL_API_KEY (instance=None) is unrestricted."""
    if instance is not None and instance.team_id != team.id:
        raise HTTPException(403, "instance not registered for this team")


async def _get_team_by_code(db: AsyncSession, code: str) -> Team:
    team = (await db.execute(select(Team).where(Team.code == code))).scalar_one_or_none()
    if not team:
        raise HTTPException(404, "team not found")
    return team


class ExternalCFAccountOut(BaseModel):
    email: str | None
    name: str
    account_id: str | None
    is_active: bool

    class Config:
        from_attributes = True


@router.get("/teams/{code}/cf-accounts", response_model=list[ExternalCFAccountOut])
async def list_cf_accounts_by_team_code(
    code: str,
    db: AsyncSession = Depends(get_db),
    instance: BurncheckInstance | None = Depends(require_external_api_key),
):
    team = await _get_team_by_code(db, code)
    _check_team_access(instance, team)
    result = await db.execute(
        select(CloudflareAccount).where(
            CloudflareAccount.team_id == team.id,
            CloudflareAccount.is_active == True,
        )
    )
    return result.scalars().all()


class SiberguvenlikConfirm(BaseModel):
    confirmed: bool = True


class DomainStatusOut(BaseModel):
    name: str
    zone_status: str | None
    removed_from_cf: bool
    abuse_reason: str | None
    siberguvenlik_listed: bool
    siberguvenlik_confirmed_at: datetime | None
    last_checked_at: datetime | None

    class Config:
        from_attributes = True


async def _get_domain_in_team(db: AsyncSession, team: Team, domain_name: str) -> Domain:
    result = await db.execute(
        select(Domain)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .where(CloudflareAccount.team_id == team.id, Domain.name == domain_name.lower())
    )
    domain = result.scalar_one_or_none()
    if not domain:
        raise HTTPException(404, "domain not found")
    return domain


@router.post("/teams/{code}/domains/{name}/siberguvenlik")
async def confirm_siberguvenlik(
    code: str,
    name: str,
    data: SiberguvenlikConfirm,
    db: AsyncSession = Depends(get_db),
    instance: BurncheckInstance | None = Depends(require_external_api_key),
):
    """BurnCheck calls this once, the first time it confirms a domain is
    listed on siberguvenlik.gov.tr. Idempotent: repeat calls are a no-op
    once already recorded (siberguvenlik_confirmed_at stays at first-seen)."""
    team = await _get_team_by_code(db, code)
    _check_team_access(instance, team)
    domain = await _get_domain_in_team(db, team, name)
    if data.confirmed and not domain.siberguvenlik_listed:
        domain.siberguvenlik_listed = True
        domain.siberguvenlik_confirmed_at = datetime.now(timezone.utc)
        await db.commit()
    return {"ok": True, "siberguvenlik_listed": domain.siberguvenlik_listed,
            "siberguvenlik_confirmed_at": domain.siberguvenlik_confirmed_at}


@router.get("/teams/{code}/domains/{name}/status", response_model=DomainStatusOut)
async def get_domain_status(
    code: str,
    name: str,
    db: AsyncSession = Depends(get_db),
    instance: BurncheckInstance | None = Depends(require_external_api_key),
):
    """Pull/reconciliation endpoint — lets a BurnCheck instance periodically
    re-sync a domain's state in case a push notification was missed."""
    team = await _get_team_by_code(db, code)
    _check_team_access(instance, team)
    domain = await _get_domain_in_team(db, team, name)
    return DomainStatusOut(
        name=domain.name,
        zone_status=str(domain.zone_status) if domain.zone_status else None,
        removed_from_cf=domain.removed_from_cf,
        abuse_reason=domain.abuse_reason,
        siberguvenlik_listed=domain.siberguvenlik_listed,
        siberguvenlik_confirmed_at=domain.siberguvenlik_confirmed_at,
        last_checked_at=domain.last_checked_at,
    )
