from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from typing import Optional
from app.db.session import get_db
import asyncio
import logging
import secrets

from app.db.session import AsyncSessionLocal
from app.models.models import Team, CloudflareAccount, KeitaroInstance, CnameTarget, Purchase, User, BurncheckInstance
from app.core.security import require_admin, get_current_user, require_delete_token
from app.services.cloudflare.cf_zones import verify_account
from app.services.audit import log_action

_log = logging.getLogger(__name__)


async def _sync_cf_account_bg(account_id: int):
    """Run sync in its own session after the request returns.
    Errors are swallowed and logged — failure shouldn't surface to the user
    who just added the account; the next periodic sync (every 30 min) will
    retry anyway."""
    from app.services.cloudflare.cf_sync import sync_account
    async with AsyncSessionLocal() as db:
        try:
            acc = await db.get(CloudflareAccount, account_id)
            if not acc:
                return
            stats = await sync_account(acc, db)
            await db.commit()
            _log.info("[cf_initial_sync] %s done: %s", acc.name, stats)
        except Exception:
            _log.exception("[cf_initial_sync] account_id=%s failed", account_id)


async def _save_creds_to_passwords(
    db: AsyncSession, user: User, *, provider: str, label: str,
    login: str | None, secret: str, url: str | None = None,
    tags: str = "auto,api",
):
    """Mirror an API-account credential into the user's Passwords store
    (the existing `purchases` table with category='account'). Idempotent:
    if a Purchase with same label + provider + login already exists for
    the user, we update its password instead of duplicating."""
    if not user:
        return
    existing = (await db.execute(
        select(Purchase).where(
            Purchase.owner_user_id == user.id,
            Purchase.provider == provider,
            Purchase.label == label,
        )
    )).scalar_one_or_none()
    if existing:
        existing.login = login
        existing.password = secret
        existing.url = url or existing.url
        existing.status = "active"
        return
    db.add(Purchase(
        owner_user_id=user.id,
        category="account",
        label=label,
        provider=provider,
        login=login,
        password=secret,
        url=url,
        status="active",
        tags=tags,
    ))

router = APIRouter(prefix="/api/teams", tags=["teams"])

class TeamCreate(BaseModel):
    name: str
    description: Optional[str] = None
    code: Optional[str] = None

class TeamOut(BaseModel):
    id: int
    name: str
    description: Optional[str]
    code: Optional[str] = None
    is_active: bool = True
    class Config:
        from_attributes = True

class CFAccountCreate(BaseModel):
    name: str
    api_key: str
    email: Optional[str] = None

class CFAccountOut(BaseModel):
    id: int
    team_id: int
    name: str
    account_id: Optional[str]
    email: Optional[str]
    is_active: bool
    created_by_user_id: Optional[int] = None
    created_by_username: Optional[str] = None
    last_synced_at: Optional[datetime] = None
    domains_count: int = 0
    class Config:
        from_attributes = True

class KTInstanceCreate(BaseModel):
    name: str
    url: str
    api_key: str
    cname: Optional[str] = None

class CFAccountUpdate(BaseModel):
    name: Optional[str] = None
    api_key: Optional[str] = None
    email: Optional[str] = None

class KTInstanceUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    api_key: Optional[str] = None
    cname: Optional[str] = None

class KTInstanceOut(BaseModel):
    id: int
    team_id: int
    name: str
    url: str
    cname: Optional[str]
    is_active: bool
    class Config:
        from_attributes = True

class BurncheckInstanceCreate(BaseModel):
    label: str
    webhook_url: Optional[str] = None
    allowed_ip: Optional[str] = None

class BurncheckInstanceUpdate(BaseModel):
    label: Optional[str] = None
    webhook_url: Optional[str] = None
    allowed_ip: Optional[str] = None

class BurncheckInstanceOut(BaseModel):
    id: int
    team_id: int
    label: str
    webhook_url: Optional[str]
    api_key: str
    allowed_ip: Optional[str]
    class Config:
        from_attributes = True

class CnameTargetCreate(BaseModel):
    cname: str
    description: Optional[str] = None

class CnameTargetUpdate(BaseModel):
    cname: Optional[str] = None
    description: Optional[str] = None

class CnameTargetOut(BaseModel):
    id: int
    team_id: int
    cname: str
    description: Optional[str]
    class Config:
        from_attributes = True

async def _cf_to_out(acc: CloudflareAccount, db: AsyncSession,
                      domain_counts: Optional[dict[int, int]] = None) -> CFAccountOut:
    out = CFAccountOut.model_validate(acc)
    if acc.created_by_user_id:
        u = await db.get(User, acc.created_by_user_id)
        out.created_by_username = u.username if u else None
    if domain_counts is not None:
        out.domains_count = domain_counts.get(acc.id, 0)
    return out


async def _domain_counts_by_cf(db: AsyncSession) -> dict[int, int]:
    """One round-trip GROUP BY so the list endpoint doesn't N+1 over Domain."""
    from sqlalchemy import func as _func
    from app.models.models import Domain as _Domain
    rows = (await db.execute(
        select(_Domain.cf_account_id, _func.count(_Domain.id))
        .group_by(_Domain.cf_account_id)
    )).all()
    return {cf_id: cnt for cf_id, cnt in rows}


@router.get("/cf-accounts-all", response_model=list[CFAccountOut])
async def list_all_cf_accounts(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(CloudflareAccount).order_by(CloudflareAccount.name))
    rows = result.scalars().all()
    counts = await _domain_counts_by_cf(db)
    return [await _cf_to_out(a, db, counts) for a in rows]


@router.get("", response_model=list[TeamOut])
async def list_teams(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(Team).order_by(Team.name))
    return result.scalars().all()

@router.post("", response_model=TeamOut, dependencies=[Depends(require_admin)])
async def create_team(data: TeamCreate, db: AsyncSession = Depends(get_db),
                       user: User = Depends(get_current_user)):
    team = Team(name=data.name, description=data.description,
                code=(data.code.strip() or None) if data.code else None)
    db.add(team)
    log_action(db, "team_add", user=user, target=data.name,
               details={"description": data.description})
    await db.flush()
    await db.refresh(team)
    return team

class TeamUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    code: Optional[str] = None

@router.patch("/{team_id}", response_model=TeamOut, dependencies=[Depends(require_admin)])
async def update_team(team_id: int, data: TeamUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Team).where(Team.id == team_id))
    team = result.scalar_one_or_none()
    if not team:
        raise HTTPException(404, "Team not found")
    if data.name is not None and data.name.strip():
        team.name = data.name.strip()
    if data.description is not None:
        team.description = data.description.strip() or None
    if data.code is not None:
        team.code = data.code.strip() or None
    await db.flush()
    await db.refresh(team)
    await db.commit()
    return team

@router.delete("/{team_id}", dependencies=[Depends(require_delete_token)])
async def delete_team(team_id: int, db: AsyncSession = Depends(get_db),
                       user: User = Depends(get_current_user)):
    """Soft-delete only: a hard delete here would cascade through every CF
    account the team owns and wipe every one of their domains (and DNS
    history) with no way back. Deactivating instead keeps everything intact
    and reversible — reactivate via PATCH is_active=true."""
    result = await db.execute(select(Team).where(Team.id == team_id))
    team = result.scalar_one_or_none()
    if not team:
        raise HTTPException(404, "Team not found")
    from app.models.models import CloudflareAccount as _CFAccount, Domain as _Domain
    cf_count = (await db.execute(
        select(func.count(_CFAccount.id)).where(_CFAccount.team_id == team_id)
    )).scalar_one()
    domain_count = (await db.execute(
        select(func.count(_Domain.id))
        .join(_CFAccount, _Domain.cf_account_id == _CFAccount.id)
        .where(_CFAccount.team_id == team_id)
    )).scalar_one()
    log_action(db, "team_delete", user=user, target=team.name,
               details={"mode": "soft", "cf_accounts_affected": cf_count, "domains_affected": domain_count})
    team.is_active = False
    await db.commit()
    return {"ok": True, "cf_accounts_affected": cf_count, "domains_affected": domain_count}

@router.get("/{team_id}/cf-accounts", response_model=list[CFAccountOut])
async def list_cf_accounts(team_id: int, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(CloudflareAccount).where(CloudflareAccount.team_id == team_id))
    counts = await _domain_counts_by_cf(db)
    return [await _cf_to_out(a, db, counts) for a in result.scalars().all()]

@router.post("/{team_id}/cf-accounts", response_model=CFAccountOut, dependencies=[Depends(require_admin)])
async def add_cf_account(team_id: int, data: CFAccountCreate,
                          db: AsyncSession = Depends(get_db),
                          user: User = Depends(get_current_user)):
    team = await db.get(Team, team_id)
    if not team:
        raise HTTPException(404, "Team not found")
    # Try to resolve account_id — but don't block if token has limited permissions
    is_valid, acc_id = await verify_account(data.email, data.api_key)
    account = CloudflareAccount(
        team_id=team_id, name=data.name, api_key=data.api_key,
        email=data.email,
        account_id=acc_id if is_valid else None,
        is_active=True,  # always add as active; sync will mark inactive if truly invalid
        created_by_user_id=user.id,
    )
    db.add(account)
    log_action(db, "cf_account_add", user=user, target=data.name,
               details={"team": team.name, "email": data.email, "valid": is_valid})
    # Mirror into Passwords (purchases.category='account')
    await _save_creds_to_passwords(
        db, user, provider="Cloudflare",
        label=f"Cloudflare: {data.name} [{team.name}]",
        login=data.email, secret=data.api_key,
        url="https://dash.cloudflare.com",
        tags="auto,cf,api",
    )
    await db.flush()
    await db.refresh(account)
    # Kick off initial sync in background — don't block the response.
    # The request session is closed after return, so the bg task opens its own.
    await db.commit()
    asyncio.create_task(_sync_cf_account_bg(account.id))
    return account

@router.patch("/{team_id}/cf-accounts/{account_id}", response_model=CFAccountOut, dependencies=[Depends(require_admin)])
async def update_cf_account(team_id: int, account_id: int, data: CFAccountUpdate,
                             db: AsyncSession = Depends(get_db),
                             user: User = Depends(get_current_user)):
    result = await db.execute(select(CloudflareAccount).where(CloudflareAccount.id == account_id, CloudflareAccount.team_id == team_id))
    acc = result.scalar_one_or_none()
    if not acc:
        raise HTTPException(404, "Account not found")
    if data.name is not None:
        acc.name = data.name.strip()
    if data.email is not None:
        acc.email = data.email.strip() or None
    api_changed = False
    if data.api_key is not None and data.api_key.strip():
        new_key = data.api_key.strip()
        email = data.email.strip() if data.email is not None else acc.email
        is_valid, acc_id = await verify_account(email, new_key)
        acc.api_key = new_key
        acc.account_id = acc_id if is_valid else acc.account_id
        acc.is_active = True  # reset to active; sync will re-check
        api_changed = True
        # Refresh stored password entry
        team = await db.get(Team, team_id)
        await _save_creds_to_passwords(
            db, user, provider="Cloudflare",
            label=f"Cloudflare: {acc.name} [{team.name if team else '—'}]",
            login=email, secret=new_key,
            url="https://dash.cloudflare.com",
            tags="auto,cf,api",
        )
    log_action(db, "cf_account_update", user=user, target=acc.name,
               details={"api_key_rotated": api_changed,
                        "name_changed": data.name is not None,
                        "email_changed": data.email is not None})
    await db.flush()
    await db.refresh(acc)
    await db.commit()
    return acc

@router.delete("/{team_id}/cf-accounts/{account_id}", dependencies=[Depends(require_delete_token)])
async def delete_cf_account(team_id: int, account_id: int, db: AsyncSession = Depends(get_db),
                             user: User = Depends(get_current_user)):
    """Soft-delete only: a hard delete here cascades (FK ondelete=CASCADE)
    and permanently wipes every Domain row (+ DNS history) under this
    account with no way back. Deactivating instead keeps everything
    intact — domains stay exactly as they were, reactivate via PATCH."""
    result = await db.execute(select(CloudflareAccount).where(CloudflareAccount.id == account_id, CloudflareAccount.team_id == team_id))
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(404, "Account not found")
    from app.models.models import Domain as _Domain
    domain_count = (await db.execute(
        select(func.count(_Domain.id)).where(_Domain.cf_account_id == account_id)
    )).scalar_one()
    log_action(db, "cf_account_delete", user=user, target=account.name,
               details={"team_id": team_id, "email": account.email, "mode": "soft", "domains_affected": domain_count})
    account.is_active = False
    await db.commit()
    return {"ok": True, "domains_affected": domain_count}


# ── CF account detail + cleanup ───────────────────────────────────────────

@router.get("/cf-accounts/{account_id}/detail")
async def cf_account_detail(account_id: int, db: AsyncSession = Depends(get_db),
                            _=Depends(get_current_user)):
    """Aggregated view for the Cloudflare detail panel: account meta,
    domains breakdown, recent action-log entries touching this account,
    and live CF abuse reports filtered by account name."""
    from sqlalchemy import func, case
    from app.models.models import Domain, DomainStatus, ActionLog, Team

    acc = await db.get(CloudflareAccount, account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    team = await db.get(Team, acc.team_id)
    creator = await db.get(User, acc.created_by_user_id) if acc.created_by_user_id else None

    # Domain stats
    stats_row = (await db.execute(
        select(
            func.count(Domain.id).label("total"),
            func.count(case((Domain.zone_status == DomainStatus.active, 1))).label("active"),
            func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).label("suspended"),
            func.count(case((Domain.zone_status == DomainStatus.pending, 1))).label("pending"),
        )
        .where(Domain.cf_account_id == account_id)
    )).one()

    # Recent logs touching this account's domains.
    # ActionLog has no FK; we filter by either domain name (joined to Domain)
    # OR by details substring containing the CF account name.
    domain_names = [n for (n,) in (await db.execute(
        select(Domain.name).where(Domain.cf_account_id == account_id)
    )).all()]
    log_q = select(ActionLog).order_by(ActionLog.created_at.desc()).limit(100)
    if domain_names:
        log_q = log_q.where(
            (ActionLog.domain.in_(domain_names)) |
            (ActionLog.details.ilike(f"%|{acc.name}%"))
        )
    else:
        log_q = log_q.where(ActionLog.details.ilike(f"%|{acc.name}%"))
    log_rows = (await db.execute(log_q)).scalars().all()

    # Live abuse reports for this account
    try:
        from app.api.domains import _fetch_cf_abuse
        abuse = await _fetch_cf_abuse(acc) if acc.is_active else []
    except Exception:
        abuse = []

    return {
        "account": {
            "id": acc.id,
            "name": acc.name,
            "email": acc.email,
            "account_id": acc.account_id,
            "team": {"id": team.id if team else None, "name": team.name if team else None},
            "is_active": acc.is_active,
            "last_synced_at": acc.last_synced_at.isoformat() if acc.last_synced_at else None,
            "created_at": acc.created_at.isoformat() if acc.created_at else None,
            "created_by": creator.username if creator else None,
        },
        "stats": {
            "total": stats_row.total or 0,
            "active": stats_row.active or 0,
            "suspended": stats_row.suspended or 0,
            "pending": stats_row.pending or 0,
        },
        "abuse_reports": abuse,
        "logs": [
            {
                "id": l.id, "action": l.action, "user": l.user,
                "domain": l.domain, "details": l.details,
                "created_at": l.created_at.isoformat() if l.created_at else None,
            }
            for l in log_rows
        ],
    }


class CFCleanupRequest(BaseModel):
    mode: str = "suspended"  # "suspended" | "cf_abuse" | "both"
    dry_run: bool = False


@router.post("/cf-accounts/{account_id}/cleanup", dependencies=[Depends(require_admin)])
async def cf_account_cleanup(account_id: int, data: CFCleanupRequest,
                              db: AsyncSession = Depends(get_db)):
    """Remove abused / suspended domains from a single CF account.
    Reuses the existing full-zone-delete pipeline so the action log is
    populated identically to manual deletions."""
    from app.models.models import Domain, DomainStatus, ActionLog, Team
    from app.services.cloudflare.cf_dns import delete_full_zone_from_cf

    acc = await db.get(CloudflareAccount, account_id)
    if not acc:
        raise HTTPException(404, "Account not found")
    team = await db.get(Team, acc.team_id)

    targets: dict[int, Domain] = {}

    if data.mode in ("suspended", "both"):
        rows = (await db.execute(
            select(Domain).where(
                Domain.cf_account_id == account_id,
                Domain.zone_status == DomainStatus.suspended,
            )
        )).scalars().all()
        for d in rows:
            targets[d.id] = d

    reason_by_name: dict[str, str] = {}
    if data.mode in ("cf_abuse", "both"):
        try:
            from app.api.domains import _fetch_cf_abuse
            reports = await _fetch_cf_abuse(acc) if acc.is_active else []
        except Exception:
            reports = []
        reason_by_name = {(r.get("domain") or "").lower(): r["reason"] for r in reports if r.get("domain")}
        names = set(reason_by_name.keys())
        if names:
            rows = (await db.execute(
                select(Domain).where(
                    Domain.cf_account_id == account_id,
                    Domain.name.in_(list(names)),
                )
            )).scalars().all()
            for d in rows:
                targets[d.id] = d

    candidates = [{"id": d.id, "name": d.name, "zone_status": str(d.zone_status)} for d in targets.values()]
    if data.dry_run:
        return {"dry_run": True, "mode": data.mode, "candidates": candidates, "count": len(candidates)}

    from app.api.domains import soft_delete_domain

    results = []
    for d in list(targets.values()):
        ok = await delete_full_zone_from_cf(acc.email, acc.api_key, d.zone_id)
        db.add(ActionLog(
            action="full_delete_cf",
            domain=d.name,
            details=f"cleanup-{data.mode}|{team.name if team else '—'}|{acc.name}",
        ))
        await soft_delete_domain(db, d, reason_by_name.get(d.name.lower()))
        results.append({"domain": d.name, "ok": ok})
    await db.commit()
    return {"dry_run": False, "mode": data.mode, "results": results, "count": len(results)}

@router.get("/{team_id}/kt-instances", response_model=list[KTInstanceOut])
async def list_kt_instances(team_id: int, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(KeitaroInstance).where(KeitaroInstance.team_id == team_id))
    return result.scalars().all()

@router.post("/{team_id}/kt-instances", response_model=KTInstanceOut, dependencies=[Depends(require_admin)])
async def add_kt_instance(team_id: int, data: KTInstanceCreate, db: AsyncSession = Depends(get_db)):
    team = await db.get(Team, team_id)
    if not team:
        raise HTTPException(404, "Team not found")
    instance = KeitaroInstance(team_id=team_id, name=data.name, url=data.url.rstrip("/"), api_key=data.api_key, cname=data.cname)
    db.add(instance)
    await db.flush()
    await db.refresh(instance)
    return instance

@router.patch("/{team_id}/kt-instances/{instance_id}", response_model=KTInstanceOut, dependencies=[Depends(require_admin)])
async def update_kt_instance(team_id: int, instance_id: int, data: KTInstanceUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(KeitaroInstance).where(KeitaroInstance.id == instance_id, KeitaroInstance.team_id == team_id))
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(404, "Instance not found")
    if data.name is not None:
        inst.name = data.name.strip()
    if data.url is not None:
        inst.url = data.url.rstrip("/")
    if data.api_key is not None and data.api_key.strip():
        inst.api_key = data.api_key.strip()
    if data.cname is not None:
        inst.cname = data.cname.strip() or None
    await db.flush()
    await db.refresh(inst)
    await db.commit()
    return inst

@router.delete("/{team_id}/kt-instances/{instance_id}", dependencies=[Depends(require_delete_token)])
async def delete_kt_instance(team_id: int, instance_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(KeitaroInstance).where(KeitaroInstance.id == instance_id, KeitaroInstance.team_id == team_id))
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(404, "Instance not found")
    await db.delete(inst)
    return {"ok": True}


# ── CNAME targets (tracker-agnostic — KT, Binom, whatever) ────────────────

@router.get("/{team_id}/cname-targets", response_model=list[CnameTargetOut])
async def list_cname_targets(team_id: int, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(CnameTarget).where(CnameTarget.team_id == team_id).order_by(CnameTarget.id)
    )
    return result.scalars().all()

@router.post("/{team_id}/cname-targets", response_model=CnameTargetOut, dependencies=[Depends(require_admin)])
async def add_cname_target(team_id: int, data: CnameTargetCreate, db: AsyncSession = Depends(get_db)):
    team = await db.get(Team, team_id)
    if not team:
        raise HTTPException(404, "Team not found")
    target = CnameTarget(team_id=team_id, cname=data.cname.strip(), description=(data.description or "").strip() or None)
    db.add(target)
    await db.flush()
    await db.refresh(target)
    return target

@router.patch("/{team_id}/cname-targets/{target_id}", response_model=CnameTargetOut, dependencies=[Depends(require_admin)])
async def update_cname_target(team_id: int, target_id: int, data: CnameTargetUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CnameTarget).where(CnameTarget.id == target_id, CnameTarget.team_id == team_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(404, "CNAME target not found")
    if data.cname is not None and data.cname.strip():
        target.cname = data.cname.strip()
    if data.description is not None:
        target.description = data.description.strip() or None
    await db.flush()
    await db.refresh(target)
    await db.commit()
    return target

@router.delete("/{team_id}/cname-targets/{target_id}", dependencies=[Depends(require_delete_token)])
async def delete_cname_target(team_id: int, target_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CnameTarget).where(CnameTarget.id == target_id, CnameTarget.team_id == team_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(404, "CNAME target not found")
    await db.delete(target)
    return {"ok": True}


# ── BurnCheck instances (per-team registration for /api/external push+pull) ──

@router.get("/{team_id}/burncheck-instances", response_model=list[BurncheckInstanceOut],
            dependencies=[Depends(require_admin)])
async def list_burncheck_instances(team_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(BurncheckInstance).where(BurncheckInstance.team_id == team_id))
    return result.scalars().all()

@router.post("/{team_id}/burncheck-instances", response_model=BurncheckInstanceOut,
             dependencies=[Depends(require_admin)])
async def add_burncheck_instance(team_id: int, data: BurncheckInstanceCreate, db: AsyncSession = Depends(get_db)):
    team = await db.get(Team, team_id)
    if not team:
        raise HTTPException(404, "Team not found")
    instance = BurncheckInstance(
        team_id=team_id, label=data.label,
        webhook_url=(data.webhook_url or "").strip() or None,
        allowed_ip=(data.allowed_ip or "").strip() or None,
        api_key=secrets.token_urlsafe(32),
    )
    db.add(instance)
    await db.flush()
    await db.refresh(instance)
    await db.commit()
    return instance

@router.patch("/{team_id}/burncheck-instances/{instance_id}", response_model=BurncheckInstanceOut,
              dependencies=[Depends(require_admin)])
async def update_burncheck_instance(team_id: int, instance_id: int, data: BurncheckInstanceUpdate,
                                     db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(BurncheckInstance).where(
        BurncheckInstance.id == instance_id, BurncheckInstance.team_id == team_id))
    instance = result.scalar_one_or_none()
    if not instance:
        raise HTTPException(404, "Instance not found")
    if data.label is not None and data.label.strip():
        instance.label = data.label.strip()
    if data.webhook_url is not None:
        instance.webhook_url = data.webhook_url.strip() or None
    if data.allowed_ip is not None:
        instance.allowed_ip = data.allowed_ip.strip() or None
    await db.flush()
    await db.refresh(instance)
    await db.commit()
    return instance

@router.post("/{team_id}/burncheck-instances/{instance_id}/rotate-key", response_model=BurncheckInstanceOut,
             dependencies=[Depends(require_admin)])
async def rotate_burncheck_instance_key(team_id: int, instance_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(BurncheckInstance).where(
        BurncheckInstance.id == instance_id, BurncheckInstance.team_id == team_id))
    instance = result.scalar_one_or_none()
    if not instance:
        raise HTTPException(404, "Instance not found")
    instance.api_key = secrets.token_urlsafe(32)
    await db.flush()
    await db.refresh(instance)
    await db.commit()
    return instance

@router.delete("/{team_id}/burncheck-instances/{instance_id}", dependencies=[Depends(require_delete_token)])
async def delete_burncheck_instance(team_id: int, instance_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(BurncheckInstance).where(
        BurncheckInstance.id == instance_id, BurncheckInstance.team_id == team_id))
    instance = result.scalar_one_or_none()
    if not instance:
        raise HTTPException(404, "Instance not found")
    await db.delete(instance)
    return {"ok": True}
