import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func, delete
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone
from app.db.session import get_db
from app.models.models import (
    Domain, CloudflareAccount, Team, DnsRecord,
    DomainStatus, RecordType, KeitaroDomainGroup, KeitaroInstance, ActionLog, AbuseAlert
)
from app.core.security import get_current_user, require_admin, require_delete_token
from app.services.cloudflare.cf_sync import sync_account, sync_all_accounts
from app.services.cloudflare.cf_dns import (
    create_record, delete_record, bulk_swap_records,
    delete_all_dns_records, delete_full_zone_from_cf
)
from app.services.cloudflare.cf_zones import fetch_dns_records, create_zone, set_ssl_mode

router = APIRouter(prefix="/api/domains", tags=["domains"])


class DomainOut(BaseModel):
    id: int
    zone_id: str
    name: str
    zone_status: DomainStatus
    main_record_type: Optional[RecordType]
    main_record_value: Optional[str]
    direct_to_keitaro: bool = False
    registered_at: Optional[datetime]
    expires_at: Optional[datetime]
    last_checked_at: Optional[datetime]
    cf_account_id: int
    cf_account_name: Optional[str] = None
    cf_account_active: Optional[bool] = None
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    keitaro_group_id: Optional[int]
    keitaro_group_name: Optional[str] = None
    keitaro_instance_name: Optional[str] = None
    notes: Optional[str]
    name_servers: Optional[str] = None
    added_by_user_id: Optional[int] = None
    added_by_username: Optional[str] = None
    abuse_count: int = 0
    removed_from_cf: bool = False
    abuse_reason: Optional[str] = None
    class Config:
        from_attributes = True


class BulkDnsUpdate(BaseModel):
    domain_ids: list[int]
    record_type: RecordType
    value: str
    proxied: bool = True


class DnsRecordCreate(BaseModel):
    record_type: RecordType
    name: str
    value: str
    ttl: int = 1
    proxied: bool = False


class DnsRecordOut(BaseModel):
    id: int
    cf_record_id: Optional[str]
    record_type: RecordType
    name: str
    value: str
    ttl: int
    proxied: bool
    class Config:
        from_attributes = True


class LogOut(BaseModel):
    id: int
    action: str
    user: Optional[str]
    domain: Optional[str]
    details: Optional[str]
    created_at: datetime
    class Config:
        from_attributes = True


class DomainFilters:
    """Shared query params for listing/counting domains — kept as one
    dependency so the filtered count always matches the filtered list."""
    def __init__(
        self,
        team_id: Optional[str] = Query(None),
        cf_account_id: Optional[str] = Query(None),
        status: Optional[str] = Query(None),
        zone: Optional[str] = Query(None),
        search: Optional[str] = Query(None),
        keitaro_group_id: Optional[str] = Query(None),
        keitaro_instance_id: Optional[str] = Query(None),
        no_keitaro: Optional[str] = Query(None),
        cname_value: Optional[str] = Query(None),
        direct_to_kt: Optional[str] = Query(None),
    ):
        self.team_id = team_id
        self.cf_account_id = cf_account_id
        self.status = status
        self.zone = zone
        self.search = search
        self.keitaro_group_id = keitaro_group_id
        self.keitaro_instance_id = keitaro_instance_id
        self.no_keitaro = no_keitaro
        self.cname_value = cname_value
        self.direct_to_kt = direct_to_kt

    def build(self) -> list:
        filters = []
        if self.team_id and self.team_id.strip():
            filters.append(Team.id == int(self.team_id))
        if self.cf_account_id and self.cf_account_id.strip():
            filters.append(CloudflareAccount.id == int(self.cf_account_id))
        if self.status and self.status.strip():
            filters.append(Domain.zone_status == DomainStatus(self.status))
        if self.zone and self.zone.strip():
            filters.append(Domain.name.like(f"%{self.zone}"))
        if self.search and self.search.strip():
            filters.append(Domain.name.ilike(f"%{self.search}%"))
        if self.keitaro_group_id and self.keitaro_group_id.strip():
            filters.append(Domain.keitaro_group_id == int(self.keitaro_group_id))
        if self.keitaro_instance_id and self.keitaro_instance_id.strip():
            filters.append(KeitaroInstance.id == int(self.keitaro_instance_id))
        if self.no_keitaro and self.no_keitaro not in ("false", "0", ""):
            filters.append(Domain.keitaro_group_id.is_(None))
        if self.cname_value and self.cname_value.strip():
            filters.append(Domain.main_record_value.ilike(f"%{self.cname_value}%"))
        if self.direct_to_kt and self.direct_to_kt not in ("false", "0", ""):
            filters.append(Domain.direct_to_keitaro == True)
        return filters


@router.get("", response_model=list[DomainOut])
async def list_domains(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
    f: DomainFilters = Depends(),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=2000),
    # Recency window in days — 0/None means no cutoff. Ignored when `search`
    # is set: looking up a specific domain by name shouldn't hide it just
    # because it's older than the window.
    days: Optional[int] = Query(7, ge=0),
):
    from app.models.models import User as _User
    from sqlalchemy import text as _text
    q = (
        select(Domain, CloudflareAccount, Team,
               KeitaroDomainGroup, KeitaroInstance, _User)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .join(Team, CloudflareAccount.team_id == Team.id)
        .outerjoin(KeitaroDomainGroup, Domain.keitaro_group_id == KeitaroDomainGroup.id)
        .outerjoin(KeitaroInstance, KeitaroDomainGroup.keitaro_instance_id == KeitaroInstance.id)
        .outerjoin(_User, Domain.added_by_user_id == _User.id)
    )
    filters = f.build()
    if days and not (f.search and f.search.strip()):
        filters.append(Domain.created_at >= _text(f"NOW() - INTERVAL '{int(days)} days'"))
    if filters:
        q = q.where(and_(*filters))
    q = q.order_by(Domain.created_at.desc()).offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(q)
    rows = result.all()

    # Abuse-history count per domain (from AbuseAlert), one grouped query
    # instead of N — keeps the page-load fast even with the join.
    domain_ids = [domain.id for domain, *_ in rows]
    abuse_counts: dict[int, int] = {}
    if domain_ids:
        cnt_q = (
            select(AbuseAlert.domain_id, func.count(AbuseAlert.id))
            .where(AbuseAlert.domain_id.in_(domain_ids), AbuseAlert.new_status == DomainStatus.suspended)
            .group_by(AbuseAlert.domain_id)
        )
        abuse_counts = dict((await db.execute(cnt_q)).all())

    out = []
    for domain, account, team, kt_group, kt_inst, added_by in rows:
        d = DomainOut.model_validate(domain)
        d.cf_account_name = account.name
        d.cf_account_active = account.is_active
        d.team_id = team.id
        d.team_name = team.name
        d.keitaro_group_name = kt_group.name if kt_group else None
        d.keitaro_instance_name = kt_inst.name if kt_inst else None
        d.added_by_username = added_by.username if added_by else None
        d.abuse_count = abuse_counts.get(domain.id, 0)
        out.append(d)
    return out


@router.get("/count")
async def count_domains(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
    f: DomainFilters = Depends(),
):
    q = (
        select(func.count(Domain.id))
        .select_from(Domain)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .join(Team, CloudflareAccount.team_id == Team.id)
        .outerjoin(KeitaroDomainGroup, Domain.keitaro_group_id == KeitaroDomainGroup.id)
        .outerjoin(KeitaroInstance, KeitaroDomainGroup.keitaro_instance_id == KeitaroInstance.id)
    )
    filters = f.build()
    if filters:
        q = q.where(and_(*filters))
    result = await db.execute(q)
    return {"count": result.scalar()}


@router.post("/sync/{cf_account_id}", dependencies=[Depends(require_admin)])
async def sync_cf_account(cf_account_id: int, db: AsyncSession = Depends(get_db)):
    account = await db.get(CloudflareAccount, cf_account_id)
    if not account:
        raise HTTPException(404, "CF account not found")
    stats = await sync_account(account, db)
    await db.commit()
    return {"ok": True, "stats": stats}


# In-memory status of the current sync-all run. One-slot — only one global
# sync at a time. Survives until next restart.
_sync_all_status: dict = {"running": False, "started_at": None,
                          "finished_at": None, "stats": None, "error": None}


async def _sync_all_bg():
    """Background worker for sync-all. Owns its DB session."""
    import asyncio as _asyncio
    from datetime import datetime as _dt, timezone as _tz
    from sqlalchemy import text as _text

    global _sync_all_status
    _sync_all_status = {
        "running": True,
        "started_at": _dt.now(_tz.utc).isoformat(),
        "finished_at": None, "stats": None, "error": None,
    }
    try:
        async with AsyncSessionLocal() as bg_db:
            stats = await sync_all_accounts(bg_db)
            await bg_db.commit()
        _sync_all_status["stats"] = stats
        logger.info(f"[sync-all bg] done: {stats}")
    except Exception as e:
        _sync_all_status["error"] = str(e)[:500]
        logger.exception("[sync-all bg] failed")
    finally:
        from datetime import datetime as _dt, timezone as _tz
        _sync_all_status["running"] = False
        _sync_all_status["finished_at"] = _dt.now(_tz.utc).isoformat()


@router.post("/sync-all", dependencies=[Depends(require_admin)])
async def sync_all():
    """Start sync of all CF accounts in background. Returns immediately so
    the proxy chain (nginx/Traefik) doesn't time out on long syncs (36
    accounts × hundreds of zones can take many minutes)."""
    import asyncio as _asyncio
    if _sync_all_status.get("running"):
        return {"ok": False, "already_running": True,
                "started_at": _sync_all_status.get("started_at")}
    _asyncio.create_task(_sync_all_bg())
    return {"ok": True, "started": True}


@router.get("/sync-all/status", dependencies=[Depends(require_admin)])
async def sync_all_status():
    """Poll the in-memory status of the most recent sync-all run."""
    return _sync_all_status


@router.post("/bulk-dns", dependencies=[Depends(require_admin)])
async def bulk_dns(data: BulkDnsUpdate, db: AsyncSession = Depends(get_db),
                   current_user=Depends(require_admin)):
    result = await bulk_swap_records(
        data.domain_ids, data.record_type.value,
        data.value, data.proxied, db, current_user.username
    )
    await db.commit()
    return result


@router.get("/{domain_id}/dns", response_model=list[DnsRecordOut])
async def get_dns_records(domain_id: int, db: AsyncSession = Depends(get_db),
                          _=Depends(get_current_user)):
    # Fetch fresh from CF
    result = await db.execute(
        select(Domain, CloudflareAccount)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .where(Domain.id == domain_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(404, "Domain not found")
    domain, account = row
    try:
        cf_records = await fetch_dns_records(account.email, account.api_key, domain.zone_id)
        return [
            DnsRecordOut(
                id=i,
                cf_record_id=r.get("id"),
                record_type=RecordType(r["type"]) if r["type"] in RecordType.__members__ else RecordType.A,
                name=r.get("name", ""),
                value=r.get("content", ""),
                ttl=r.get("ttl", 1),
                proxied=r.get("proxied", False),
            )
            for i, r in enumerate(cf_records)
            if r.get("type") in RecordType.__members__
        ]
    except Exception:
        # Fallback to DB cache
        res = await db.execute(select(DnsRecord).where(DnsRecord.domain_id == domain_id))
        return res.scalars().all()


@router.post("/{domain_id}/dns", response_model=DnsRecordOut, dependencies=[Depends(require_admin)])
async def add_dns_record(domain_id: int, data: DnsRecordCreate,
                         db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Domain, CloudflareAccount)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .where(Domain.id == domain_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(404, "Domain not found")
    domain, account = row

    cf_resp = await create_record(
        account.email, account.api_key, domain.zone_id,
        data.record_type.value, data.name, data.value, data.ttl, data.proxied
    )
    if not cf_resp.get("success"):
        raise HTTPException(400, detail=str(cf_resp.get("errors", "CF error")))

    rec = DnsRecord(
        domain_id=domain_id,
        cf_record_id=cf_resp["result"]["id"],
        record_type=data.record_type,
        name=data.name, value=data.value,
        ttl=data.ttl, proxied=data.proxied,
    )
    db.add(rec)
    db.add(ActionLog(action="add_dns", domain=domain.name,
                     details=f"{data.record_type} {data.name} → {data.value}"))
    await db.flush()
    await db.refresh(rec)
    await db.commit()
    return rec


@router.delete("/{domain_id}/dns/{cf_record_id}", dependencies=[Depends(require_delete_token)])
async def delete_dns(domain_id: int, cf_record_id: str,
                     db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Domain, CloudflareAccount)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .where(Domain.id == domain_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(404, "Domain not found")
    domain, account = row
    ok = await delete_record(account.email, account.api_key, domain.zone_id, cf_record_id)
    if ok:
        db.add(ActionLog(action="delete_dns", domain=domain.name, details=f"record {cf_record_id}"))
        await db.commit()
    return {"ok": ok}


@router.delete("/{domain_id}/all-dns", dependencies=[Depends(require_delete_token)])
async def delete_all_dns(domain_id: int, db: AsyncSession = Depends(get_db)):
    """Delete ALL DNS records from zone (keeps zone in CF)."""
    result = await db.execute(
        select(Domain, CloudflareAccount)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .where(Domain.id == domain_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(404, "Domain not found")
    domain, account = row
    deleted = await delete_all_dns_records(account.email, account.api_key, domain.zone_id)
    domain.main_record_type = None
    domain.main_record_value = None
    db.add(ActionLog(action="delete_all_dns", domain=domain.name, details=f"deleted {deleted} records"))
    await db.commit()
    return {"ok": True, "deleted": deleted}


# ── Abuse reason formatting + soft-delete ──────────────────────────────────
# CF's abuse-reports API returns `type` (PHISH/DMCA/...) and `original_work`
# (targeted brand, e.g. "Ziraat Bank"). We render that as "Phishing: Ziraat Bank".

_ABUSE_TYPE_LABELS = {
    "PHISH": "Phishing", "GEN": "General", "THREAT": "Threat", "DMCA": "DMCA",
    "EMER": "Emergency", "TM": "Trademark", "REG_WHO": "Registrar/WHOIS",
    "NCSEI": "NCSEI", "NETWORK": "Network Abuse",
}


def format_abuse_reason(report_type: str | None, original_work: str | None) -> str:
    label = _ABUSE_TYPE_LABELS.get((report_type or "").upper(), report_type or "Abuse")
    return f"{label}: {original_work}" if original_work else label


async def soft_delete_domain(db: AsyncSession, domain: Domain, reason: str | None = None) -> None:
    """Remove a domain's DNS footprint but keep the row (and its history).
    Called after the zone itself has already been deleted from Cloudflare."""
    await db.execute(delete(DnsRecord).where(DnsRecord.domain_id == domain.id))
    domain.main_record_type = None
    domain.main_record_value = None
    domain.removed_from_cf = True
    if reason:
        domain.abuse_reason = reason


class BulkAbuseDeleteRequest(BaseModel):
    domains: list[str]  # list of domain names

@router.post("/bulk-abuse-delete", dependencies=[Depends(require_admin)])
async def bulk_abuse_delete(data: BulkAbuseDeleteRequest, db: AsyncSession = Depends(get_db)):
    """Remove multiple domains from CF without OTP — for abuse report cleanup.
    Domain rows are kept (soft-deleted) so team/DNS/abuse history isn't lost."""
    results = []
    reason_cache: dict[int, dict[str, str]] = {}  # cf_account_id -> {domain_name: reason}
    for name in data.domains:
        name = name.lower().strip()
        row = (await db.execute(
            select(Domain, CloudflareAccount, Team)
            .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
            .join(Team, CloudflareAccount.team_id == Team.id)
            .where(Domain.name == name)
        )).first()
        if not row:
            results.append({"domain": name, "ok": False, "error": "not in DB"})
            continue
        domain, account, team = row
        ok = await delete_full_zone_from_cf(account.email, account.api_key, domain.zone_id)
        db.add(ActionLog(action="full_delete_cf", domain=domain.name, details=f"abuse|{team.name}|{account.name}"))

        if account.id not in reason_cache:
            try:
                reports = await _fetch_cf_abuse(account) if account.is_active else []
            except Exception:
                reports = []
            reason_cache[account.id] = {r["domain"].lower(): r["reason"] for r in reports if r.get("domain")}
        reason = reason_cache[account.id].get(name)

        await soft_delete_domain(db, domain, reason)
        results.append({"domain": name, "ok": ok})

        from app.services.domainguard_notify import notify_domainguard_abuse
        asyncio.create_task(notify_domainguard_abuse(
            team_id=team.id,
            domain=domain.name,
            cf_account_email=account.email,
            severity="high",
            category="removed",
            message=reason or "Zone removed from Cloudflare (abuse cleanup)",
        ))
    await db.commit()
    return {"results": results}


@router.delete("/{domain_id}/full-delete", dependencies=[Depends(require_delete_token)])
async def full_delete_from_cf(domain_id: int, db: AsyncSession = Depends(get_db)):
    """Remove zone from Cloudflare. Domain row is kept (soft-deleted); if CF
    has a live abuse report for this domain, it's captured as abuse_reason
    before the zone is deleted (once gone, the report may no longer be
    fetchable, so this must happen first)."""
    result = await db.execute(
        select(Domain, CloudflareAccount, Team)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .join(Team, CloudflareAccount.team_id == Team.id)
        .where(Domain.id == domain_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(404, "Domain not found")
    domain, account, team = row

    reason = None
    try:
        reports = await _fetch_cf_abuse(account) if account.is_active else []
        reason = next((r["reason"] for r in reports if (r.get("domain") or "").lower() == domain.name.lower()), None)
    except Exception:
        pass

    ok = await delete_full_zone_from_cf(account.email, account.api_key, domain.zone_id)
    db.add(ActionLog(action="full_delete_cf", domain=domain.name, details=f"manual|{team.name}|{account.name}"))
    await soft_delete_domain(db, domain, reason)
    await db.commit()

    from app.services.domainguard_notify import notify_domainguard_abuse
    asyncio.create_task(notify_domainguard_abuse(
        team_id=team.id,
        domain=domain.name,
        cf_account_email=account.email,
        severity="high" if reason else "medium",
        category="removed",
        message="Zone removed from Cloudflare (manual)",
    ))
    return {"ok": ok}


# ── Deleted domains log ────────────────────────────────────────────────────

@router.get("/deleted-domains", dependencies=[Depends(get_current_user)])
async def get_deleted_domains(
    db: AsyncSession = Depends(get_db),
    limit: int = Query(200, ge=1, le=1000),
):
    q = (
        select(ActionLog)
        .where(ActionLog.action == "full_delete_cf")
        .order_by(ActionLog.created_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(q)).scalars().all()
    result = []
    for log in rows:
        parts = (log.details or "").split("|")
        team = parts[1] if len(parts) > 1 else "—"
        cf_account = parts[2] if len(parts) > 2 else "—"
        source = parts[0] if parts else "manual"
        result.append({
            "id": log.id,
            "domain": log.domain,
            "team": team,
            "cf_account": cf_account,
            "source": source,
            "deleted_at": log.created_at,
        })
    return result


# ── Team Stats ─────────────────────────────────────────────────────────────

@router.get("/team-stats", dependencies=[Depends(get_current_user)])
async def get_team_stats(db: AsyncSession = Depends(get_db)):
    from sqlalchemy import case
    q = (
        select(
            Team.id,
            Team.name,
            func.count(Domain.id).label("total"),
            func.count(case((Domain.zone_status == DomainStatus.active, 1))).label("active"),
            func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).label("suspended"),
            func.count(case((Domain.zone_status == DomainStatus.pending, 1))).label("pending"),
        )
        .join(CloudflareAccount, CloudflareAccount.team_id == Team.id)
        .join(Domain, Domain.cf_account_id == CloudflareAccount.id)
        .group_by(Team.id, Team.name)
        .order_by(func.count(Domain.id).desc())
    )
    rows = (await db.execute(q)).all()
    return [
        {"id": r.id, "name": r.name, "total": r.total,
         "active": r.active, "suspended": r.suspended, "pending": r.pending}
        for r in rows
    ]


# ── Aggregated stats overview ─────────────────────────────────────────────

@router.get("/stats/overview", dependencies=[Depends(get_current_user)])
async def stats_overview(
    db: AsyncSession = Depends(get_db),
    days: int = Query(30, ge=7, le=180),
):
    """Aggregated stats used by the Dashboard «Статистика» section.

    Returns totals, ban breakdowns by team / CF account / TLD, a daily
    timeline, and purchases summary. Designed to make it easy to spot WHERE
    bans cluster and WHY (CF abuse report types). One round-trip — kept lean
    enough that the dashboard can poll it without hammering the DB."""
    from sqlalchemy import case, cast, Date
    from app.models.models import Purchase, DynadotAccount

    now = datetime.utcnow()

    def _interval(d):
        return f"NOW() - INTERVAL '{int(d)} days'"

    # ── Totals ────────────────────────────────────────────────────────
    totals_q = await db.execute(select(
        func.count(Domain.id).label("total"),
        func.count(case((Domain.zone_status == DomainStatus.active, 1))).label("active"),
        func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).label("suspended"),
        func.count(case((Domain.zone_status == DomainStatus.pending, 1))).label("pending"),
    ))
    tot = totals_q.one()
    teams_count = (await db.execute(select(func.count(Team.id)))).scalar() or 0
    cf_count = (await db.execute(select(func.count(CloudflareAccount.id)))).scalar() or 0
    dyn_count = (await db.execute(select(func.count(DynadotAccount.id)))).scalar() or 0

    # ── Bans count by period (AbuseAlert.new_status == suspended) ─────
    from sqlalchemy import text as _text
    ban_periods = {}
    for label, d in (("last_24h", 1), ("last_7d", 7), ("last_30d", 30)):
        v = (await db.execute(select(func.count(AbuseAlert.id)).where(
            AbuseAlert.new_status == DomainStatus.suspended,
            AbuseAlert.created_at > _text(_interval(d)),
        ))).scalar() or 0
        ban_periods[label] = v

    # Deletions per period (ActionLog: full_delete_cf)
    del_periods = {}
    for label, d in (("last_24h", 1), ("last_7d", 7), ("last_30d", 30)):
        v = (await db.execute(select(func.count(ActionLog.id)).where(
            ActionLog.action == "full_delete_cf",
            ActionLog.created_at > _text(_interval(d)),
        ))).scalar() or 0
        del_periods[label] = v

    # ── By team ───────────────────────────────────────────────────────
    team_rows = (await db.execute(
        select(
            Team.id, Team.name,
            func.count(Domain.id).label("total"),
            func.count(case((Domain.zone_status == DomainStatus.active, 1))).label("active"),
            func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).label("suspended"),
            func.count(case((Domain.zone_status == DomainStatus.pending, 1))).label("pending"),
        )
        .join(CloudflareAccount, CloudflareAccount.team_id == Team.id, isouter=True)
        .join(Domain, Domain.cf_account_id == CloudflareAccount.id, isouter=True)
        .group_by(Team.id, Team.name)
        .order_by(func.count(Domain.id).desc())
    )).all()

    # Bans/deletions by team in last `days`
    team_bans = {r.team_id: r.cnt for r in (await db.execute(
        select(
            CloudflareAccount.team_id.label("team_id"),
            func.count(AbuseAlert.id).label("cnt"),
        )
        .join(Domain, Domain.cf_account_id == CloudflareAccount.id)
        .join(AbuseAlert, AbuseAlert.domain_id == Domain.id)
        .where(
            AbuseAlert.new_status == DomainStatus.suspended,
            AbuseAlert.created_at > _text(_interval(days)),
        )
        .group_by(CloudflareAccount.team_id)
    )).all()}

    by_team = []
    for r in team_rows:
        total = r.total or 0
        susp = r.suspended or 0
        by_team.append({
            "id": r.id, "name": r.name,
            "total": total, "active": r.active or 0,
            "suspended": susp, "pending": r.pending or 0,
            "bans_in_window": team_bans.get(r.id, 0),
            "ban_rate_pct": round((susp / total * 100), 1) if total else 0,
        })

    # ── By CF account ────────────────────────────────────────────────
    cf_rows = (await db.execute(
        select(
            CloudflareAccount.id, CloudflareAccount.name, Team.name.label("team_name"),
            func.count(Domain.id).label("total"),
            func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).label("suspended"),
        )
        .join(Team, Team.id == CloudflareAccount.team_id, isouter=True)
        .join(Domain, Domain.cf_account_id == CloudflareAccount.id, isouter=True)
        .group_by(CloudflareAccount.id, CloudflareAccount.name, Team.name)
        .order_by(func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).desc())
    )).all()
    # Live abuse-report counts per CF account (single fetch reused below for
    # the top-suspended fallback). Empty dict on any failure.
    abuse_by_cf_id: dict[int, int] = {}
    abuse_cache: dict[int, list[dict]] = {}
    try:
        cf_accounts_active = (await db.execute(
            select(CloudflareAccount).where(CloudflareAccount.is_active == True)
        )).scalars().all()
        for acc in cf_accounts_active:
            rs = await _fetch_cf_abuse(acc)
            abuse_cache[acc.id] = rs
            abuse_by_cf_id[acc.id] = len(rs)
    except Exception:
        __import__("logging").getLogger(__name__).exception("[stats] abuse fetch failed")

    by_cf = [
        {
            "id": r.id, "name": r.name, "team": r.team_name,
            "total": r.total or 0, "suspended": r.suspended or 0,
            "abuse_reports": abuse_by_cf_id.get(r.id, 0),
            "ban_rate_pct": round(((r.suspended or 0) / r.total * 100), 1) if r.total else 0,
        }
        for r in cf_rows
    ]
    # Promote accounts with abuse reports to the top (after suspended ones)
    by_cf.sort(key=lambda x: (x["suspended"], x["abuse_reports"]), reverse=True)

    # ── By TLD ────────────────────────────────────────────────────────
    tld_expr = func.lower(func.regexp_replace(Domain.name, r'^.*\.', ''))
    tld_rows = (await db.execute(
        select(
            tld_expr.label("tld"),
            func.count(Domain.id).label("total"),
            func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).label("suspended"),
        )
        .group_by(tld_expr)
        .order_by(func.count(case((Domain.zone_status == DomainStatus.suspended, 1))).desc())
        .limit(15)
    )).all()
    by_tld = [
        {
            "tld": r.tld or "?",
            "total": r.total or 0,
            "suspended": r.suspended or 0,
            "ban_rate_pct": round(((r.suspended or 0) / r.total * 100), 1) if r.total else 0,
        }
        for r in tld_rows if (r.suspended or 0) > 0 or (r.total or 0) > 0
    ]

    # ── Timeline (last `days` days) ──────────────────────────────────
    timeline_rows = (await db.execute(
        select(
            cast(AbuseAlert.created_at, Date).label("d"),
            func.count(case((AbuseAlert.new_status == DomainStatus.suspended, 1))).label("suspended"),
            func.count(case((AbuseAlert.new_status == DomainStatus.active, 1))).label("recovered"),
        )
        .where(AbuseAlert.created_at > _text(_interval(days)))
        .group_by(_text("1"))
        .order_by(_text("1"))
    )).all()
    del_timeline_rows = (await db.execute(
        select(
            cast(ActionLog.created_at, Date).label("d"),
            func.count(ActionLog.id).label("deleted"),
        )
        .where(
            ActionLog.action == "full_delete_cf",
            ActionLog.created_at > _text(_interval(days)),
        )
        .group_by(_text("1"))
        .order_by(_text("1"))
    )).all()
    del_map = {r.d.isoformat(): r.deleted for r in del_timeline_rows}
    susp_map = {r.d.isoformat(): r for r in timeline_rows}
    # Union of all dates from both queries — otherwise deletion-only days
    # silently disappear from the chart.
    all_days = sorted(set(susp_map.keys()) | set(del_map.keys()))
    timeline = [
        {
            "date": d,
            "suspended": (susp_map[d].suspended or 0) if d in susp_map else 0,
            "recovered": (susp_map[d].recovered or 0) if d in susp_map else 0,
            "deleted": del_map.get(d, 0),
        }
        for d in all_days
    ]

    # ── Per-team ban trend (sparkline, last `days`) ──────────────────
    team_trend_rows = (await db.execute(
        select(
            CloudflareAccount.team_id.label("tid"),
            cast(AbuseAlert.created_at, Date).label("d"),
            func.count(AbuseAlert.id).label("c"),
        )
        .join(Domain, Domain.cf_account_id == CloudflareAccount.id)
        .join(AbuseAlert, AbuseAlert.domain_id == Domain.id)
        .where(
            AbuseAlert.new_status == DomainStatus.suspended,
            AbuseAlert.created_at > _text(_interval(days)),
        )
        .group_by(CloudflareAccount.team_id, _text("2"))
    )).all()
    team_trend: dict[int, dict[str, int]] = {}
    for r in team_trend_rows:
        team_trend.setdefault(r.tid, {})[r.d.isoformat()] = r.c
    for t in by_team:
        sparkline = []
        for i in range(days - 1, -1, -1):
            dt = (now.date().toordinal() - i)
            from datetime import date as _date
            iso = _date.fromordinal(dt).isoformat()
            sparkline.append(team_trend.get(t["id"], {}).get(iso, 0))
        t["sparkline"] = sparkline

    # Per-team CF/KT counts
    from app.models.models import KeitaroInstance as _KT
    cf_by_team = {r.team_id: r.c for r in (await db.execute(
        select(CloudflareAccount.team_id, func.count(CloudflareAccount.id).label("c"))
        .group_by(CloudflareAccount.team_id)
    )).all()}
    kt_by_team = {r.team_id: r.c for r in (await db.execute(
        select(_KT.team_id, func.count(_KT.id).label("c"))
        .group_by(_KT.team_id)
    )).all()}
    for t in by_team:
        t["cf_accounts"] = cf_by_team.get(t["id"], 0)
        t["kt_instances"] = kt_by_team.get(t["id"], 0)

    # ── Top problem domains ──────────────────────────────────────────
    # 1) AbuseAlert rows (zone transitioned to suspended via sync)
    # 2) Live CF abuse-reports (CF flagged but zone may still be active)
    # Both surface here so the panel isn't misleadingly empty when CF has
    # 300 reports but our `AbuseAlert` table is empty (no transitions yet).
    susp_rows = (await db.execute(
        select(AbuseAlert.id, Domain.name, Team.name.label("team"),
               CloudflareAccount.name.label("cf"), AbuseAlert.created_at)
        .join(Domain, Domain.id == AbuseAlert.domain_id)
        .join(CloudflareAccount, CloudflareAccount.id == Domain.cf_account_id)
        .outerjoin(Team, Team.id == CloudflareAccount.team_id)
        .where(AbuseAlert.new_status == DomainStatus.suspended)
        .order_by(AbuseAlert.created_at.desc())
        .limit(10)
    )).all()
    top_suspended = [
        {"id": r.id, "domain": r.name, "team": r.team, "cf_account": r.cf,
         "suspended_at": r.created_at.isoformat() if r.created_at else None,
         "source": "suspended"}
        for r in susp_rows
    ]

    # Fallback: live CF abuse reports (already fetched above) → top 10.
    if len(top_suspended) < 10 and abuse_cache:
        cf_team_name = {
            r.id: r.team_name
            for r in cf_rows
        }
        all_abuse: list[dict] = []
        for acc_id, rs in abuse_cache.items():
            for r in rs:
                r2 = dict(r)
                r2["team"] = cf_team_name.get(acc_id)
                all_abuse.append(r2)
        all_abuse.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        seen = {x["domain"] for x in top_suspended}
        for r in all_abuse:
            if len(top_suspended) >= 10:
                break
            if r["domain"] in seen:
                continue
            seen.add(r["domain"])
            top_suspended.append({
                "id": r.get("id"),
                "domain": r["domain"],
                "team": r.get("team"),
                "cf_account": r.get("cf_account"),
                "suspended_at": r.get("created_at"),
                "source": f"abuse-report:{r.get('type') or '?'}",
            })

    # ── Domain growth by month (last 12 months) ──────────────────────
    growth_rows = (await db.execute(
        select(
            func.to_char(Domain.created_at, _text("'YYYY-MM'")).label("ym"),
            func.count(Domain.id).label("c"),
        )
        .where(Domain.created_at > _text("NOW() - INTERVAL '12 months'"))
        .group_by(_text("1"))
        .order_by(_text("1"))
    )).all()
    domain_growth = [{"month": r.ym, "count": r.c} for r in growth_rows]

    # ── Purchases (deep) ─────────────────────────────────────────────
    purchases_total = (await db.execute(select(func.count(Purchase.id)))).scalar() or 0
    cat_rows = (await db.execute(
        select(Purchase.category, func.count(Purchase.id).label("c"))
        .group_by(Purchase.category)
        .order_by(func.count(Purchase.id).desc())
    )).all()
    status_rows = (await db.execute(
        select(Purchase.status, func.count(Purchase.id).label("c"))
        .group_by(Purchase.status)
    )).all()
    purchases_recent = (await db.execute(
        select(func.count(Purchase.id)).where(
            Purchase.purchased_at > _text(_interval(days))
        )
    )).scalar() or 0

    # Total + per-currency spend (cost_amount is stored as string for precision)
    all_purchases = (await db.execute(
        select(Purchase.cost_amount, Purchase.cost_currency, Purchase.purchased_at, Purchase.category)
    )).all()
    spend_by_currency: dict[str, float] = {}
    spend_by_month: dict[str, float] = {}
    spend_by_category: dict[str, float] = {}
    for amt, cur, dt, cat in all_purchases:
        try:
            v = float(str(amt).replace(",", ".")) if amt else 0
        except Exception:
            v = 0
        if v <= 0:
            continue
        cur = (cur or "USD").upper()
        spend_by_currency[cur] = round(spend_by_currency.get(cur, 0) + v, 2)
        spend_by_category[cat or "other"] = round(spend_by_category.get(cat or "other", 0) + v, 2)
        if dt:
            ym = dt.strftime("%Y-%m")
            spend_by_month[ym] = round(spend_by_month.get(ym, 0) + v, 2)

    # Expiring soon (next 30 days)
    expiring_soon = (await db.execute(
        select(func.count(Purchase.id)).where(
            Purchase.expires_at != None,
            Purchase.expires_at > _text("NOW()"),
            Purchase.expires_at < _text("NOW() + INTERVAL '30 days'"),
        )
    )).scalar() or 0

    # ── Infrastructure counts ────────────────────────────────────────
    from app.models.models import MailAccount, Proxy, RemoteServer, Identity, KeitaroInstance
    infra = {
        "mail_total":    (await db.execute(select(func.count(MailAccount.id)))).scalar() or 0,
        "proxies_total": (await db.execute(select(func.count(Proxy.id)))).scalar() or 0,
        "proxies_active": (await db.execute(select(func.count(Proxy.id)).where(Proxy.is_active == True))).scalar() or 0,
        "proxies_ok":    (await db.execute(select(func.count(Proxy.id)).where(Proxy.last_check_ok == True))).scalar() or 0,
        "servers_total": (await db.execute(select(func.count(RemoteServer.id)))).scalar() or 0,
        "servers_ok":    (await db.execute(select(func.count(RemoteServer.id)).where(RemoteServer.last_status == "ok"))).scalar() or 0,
        "identities_total": (await db.execute(select(func.count(Identity.id)))).scalar() or 0,
        "kt_instances": (await db.execute(select(func.count(KeitaroInstance.id)))).scalar() or 0,
    }

    return {
        "window_days": days,
        "generated_at": now.isoformat(),
        "totals": {
            "teams": teams_count,
            "cf_accounts": cf_count,
            "dynadot_accounts": dyn_count,
            "domains": tot.total or 0,
            "active": tot.active or 0,
            "suspended": tot.suspended or 0,
            "pending": tot.pending or 0,
        },
        "bans": ban_periods,
        "deletions": del_periods,
        "by_team": by_team,
        "by_cf_account": by_cf,
        "by_tld": by_tld,
        "timeline": timeline,
        "purchases": {
            "total": purchases_total,
            "recent": purchases_recent,
            "expiring_soon_30d": expiring_soon,
            "by_category": [{"category": r.category, "count": r.c} for r in cat_rows],
            "by_status": [{"status": r.status, "count": r.c} for r in status_rows],
            "spend_by_currency": [{"currency": k, "amount": v} for k, v in sorted(spend_by_currency.items(), key=lambda x: -x[1])],
            "spend_by_category": [{"category": k, "amount": v} for k, v in sorted(spend_by_category.items(), key=lambda x: -x[1])],
            "spend_by_month": [{"month": k, "amount": v} for k, v in sorted(spend_by_month.items())],
        },
        "infra": infra,
        "top_suspended": top_suspended,
        "domain_growth": domain_growth,
    }


# ── CF abuse reasons aggregation ──────────────────────────────────────────

@router.get("/stats/ban-reasons", dependencies=[Depends(get_current_user)])
async def stats_ban_reasons(db: AsyncSession = Depends(get_db)):
    """Pull live CF abuse reports, group by type & cf_account. Lets the
    operator quickly see WHICH report types dominate (phishing / malware /
    copyright / trademark / …) and which CF account gets flagged most."""
    reports = await get_cf_abuse_reports(db)  # type: ignore[arg-type]
    by_type: dict[str, int] = {}
    by_account: dict[str, int] = {}
    for r in reports:
        # Full "Category: Targeted brand" (e.g. "Phishing: Ziraat Bank") when
        # CF supplied original_work, same formatting as the Domains table —
        # falls back to just the category label when it didn't.
        t = r.get("reason") or (r.get("type") or "unknown").strip() or "unknown"
        by_type[t] = by_type.get(t, 0) + 1
        a = r.get("cf_account") or "?"
        by_account[a] = by_account.get(a, 0) + 1
    return {
        "total": len(reports),
        "by_type": [{"type": k, "count": v} for k, v in sorted(by_type.items(), key=lambda x: -x[1])],
        "by_cf_account": [{"name": k, "count": v} for k, v in sorted(by_account.items(), key=lambda x: -x[1])],
    }


class AddToCFRequest(BaseModel):
    cf_account_id: int
    domains: list[str]


@router.post("/add-to-cf", dependencies=[Depends(require_admin)])
async def add_domains_to_cf(data: AddToCFRequest, db: AsyncSession = Depends(get_db),
                             current_user=Depends(require_admin)):
    account = await db.get(CloudflareAccount, data.cf_account_id)
    if not account:
        raise HTTPException(404, "CF account not found")
    results = []
    for raw in data.domains:
        name = raw.strip().lower()
        if not name:
            continue
        existing = await db.execute(select(Domain).where(Domain.name == name))
        if existing.scalar_one_or_none():
            results.append({"domain": name, "status": "exists"})
            continue
        resp = await create_zone(account.email, account.api_key, name, account.account_id)
        if resp.get("success"):
            zone = resp["result"]
            await set_ssl_mode(account.email, account.api_key, zone["id"], "flexible")
            domain = Domain(
                zone_id=zone["id"],
                name=zone["name"],
                zone_status=DomainStatus(zone.get("status", "pending")),
                cf_account_id=account.id,
                added_by_user_id=current_user.id,
            )
            db.add(domain)
            db.add(ActionLog(action="cf_add_zone", domain=name, user=current_user.username,
                              details=f"Added to {account.name}"))
            results.append({"domain": name, "status": "added"})
        else:
            errs = resp.get("errors", [])
            err_msg = errs[0].get("message", "CF error") if errs else "CF error"
            results.append({"domain": name, "status": "error", "error": err_msg})
    await db.commit()
    return {"results": results}


class BulkDnsByNameRequest(BaseModel):
    domains: list[str]
    record_type: RecordType
    value: str
    proxied: bool = True


@router.post("/bulk-dns-by-name", dependencies=[Depends(require_admin)])
async def bulk_dns_by_name(
    data: BulkDnsByNameRequest, db: AsyncSession = Depends(get_db),
    current_user=Depends(require_admin),
):
    names = [n.strip().lower() for n in data.domains if n.strip()]
    result = await db.execute(select(Domain).where(Domain.name.in_(names)))
    found = result.scalars().all()
    found_names = {d.name for d in found}
    not_found = [n for n in names if n not in found_names]
    domain_ids = [d.id for d in found]
    if not domain_ids:
        return {"ok": 0, "errors": 0, "warnings": [], "results": [], "not_found": not_found}
    result = await bulk_swap_records(
        domain_ids, data.record_type.value, data.value, data.proxied, db, current_user.username
    )
    await db.commit()
    result["not_found"] = not_found
    return result


@router.get("/logs", response_model=list[LogOut], dependencies=[Depends(require_admin)])
async def get_logs(
    db: AsyncSession = Depends(get_db),
    domain: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    q = select(ActionLog).order_by(ActionLog.created_at.desc())
    if domain:
        q = q.where(ActionLog.domain.ilike(f"%{domain}%"))
    if action:
        q = q.where(ActionLog.action == action)
    q = q.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(q)
    return result.scalars().all()


# ── Quick Add ─────────────────────────────────────────────────────────────

class QuickAddRequest(BaseModel):
    domains: list[str]
    cf_account_id: int
    cname: Optional[str] = None


@router.post("/quick-add", dependencies=[Depends(require_admin)])
async def quick_add_domains(data: QuickAddRequest, db: AsyncSession = Depends(get_db),
                             current_user=Depends(require_admin)):
    """Add domains to CF and, optionally, point them at a CNAME target in one shot.
    Keitaro group assignment is a separate flow (Domains → «До Keitaro»)."""
    account = await db.get(CloudflareAccount, data.cf_account_id)
    if not account:
        raise HTTPException(404, "CF account not found")

    cname_target = (data.cname or "").strip() or None

    results = []
    for raw in data.domains:
        name = raw.strip().lower()
        if not name:
            continue
        item: dict = {"domain": name, "cf_status": None, "name_servers": [], "cname_set": False, "cf_error": None}

        existing = await db.execute(select(Domain).where(Domain.name == name))
        domain_obj = existing.scalar_one_or_none()

        if domain_obj:
            item["cf_status"] = "exists"
        else:
            resp = await create_zone(account.email, account.api_key, name, account.account_id)
            if resp.get("success"):
                zone = resp["result"]
                await set_ssl_mode(account.email, account.api_key, zone["id"], "flexible")
                item["name_servers"] = zone.get("name_servers", [])
                ns_list = zone.get("name_servers", [])
                domain_obj = Domain(
                    zone_id=zone["id"],
                    name=zone["name"],
                    zone_status=DomainStatus(zone.get("status", "pending")),
                    cf_account_id=account.id,
                    name_servers=",".join(ns_list) if ns_list else None,
                    added_by_user_id=current_user.id,
                )
                db.add(domain_obj)
                await db.flush()
                await db.refresh(domain_obj)  # ensure id is populated
                db.add(ActionLog(action="cf_add_zone", domain=name, user=current_user.username,
                                  details=f"quick-add to {account.name}"))
                item["cf_status"] = "added"
            else:
                errs = resp.get("errors", [])
                item["cf_status"] = "error"
                item["cf_error"] = errs[0].get("message", "CF error") if errs else "CF error"
                results.append(item)
                continue

        # Set CNAME → chosen target
        if cname_target and domain_obj and domain_obj.zone_id:
            cname_resp = await create_record(
                account.email, account.api_key, domain_obj.zone_id,
                "CNAME", name, cname_target, ttl=1, proxied=True
            )
            if cname_resp.get("success"):
                item["cname_set"] = True
                domain_obj.main_record_type = RecordType.CNAME
                domain_obj.main_record_value = cname_target

        results.append(item)

    await db.commit()
    return {"results": results}


# ── Abuse Alerts ──────────────────────────────────────────────────────────

@router.get("/abuse-alerts")
async def get_abuse_alerts(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
    limit: int = Query(50, ge=1, le=200),
):
    q = (
        select(AbuseAlert, Domain, Team)
        .join(Domain, AbuseAlert.domain_id == Domain.id)
        .outerjoin(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .outerjoin(Team, CloudflareAccount.team_id == Team.id)
        .order_by(AbuseAlert.created_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(q)).all()
    return [
        {
            "id": alert.id,
            "domain_name": domain.name,
            "team_name": team.name if team else None,
            "previous_status": alert.previous_status,
            "new_status": alert.new_status,
            "resolved": alert.resolved,
            "dns_deleted": alert.dns_deleted,
            "created_at": alert.created_at,
        }
        for alert, domain, team in rows
    ]


# ── CF Abuse Reports (live from CF API) ───────────────────────────────────

import httpx as _httpx
import asyncio as _asyncio
import logging as _log
_abuse_log = _log.getLogger("cf_abuse")

async def _fetch_account_id(email, api_key, headers) -> str | None:
    """Try to resolve real CF account_id if not stored."""
    try:
        async with _httpx.AsyncClient(timeout=15) as c:
            r = await c.get("https://api.cloudflare.com/client/v4/accounts?per_page=1", headers=headers)
            if r.status_code == 200 and r.json().get("success"):
                items = r.json().get("result", [])
                return items[0]["id"] if items else None
    except Exception:
        pass
    return None


async def _fetch_cf_abuse(account: CloudflareAccount) -> list[dict]:
    from app.services.cloudflare.cf_zones import make_headers
    headers = make_headers(account.email, account.api_key)

    acc_id = account.account_id
    if not acc_id or acc_id == "token":
        acc_id = await _fetch_account_id(account.email, account.api_key, headers)
    if not acc_id:
        return []

    try:
        async with _httpx.AsyncClient(timeout=20) as c:
            r = await c.get(
                f"https://api.cloudflare.com/client/v4/accounts/{acc_id}/abuse-reports",
                headers=headers,
            )
        if r.status_code != 200:
            _abuse_log.warning(f"[cf_abuse] {account.name} HTTP {r.status_code}")
            return []
        data = r.json()
        if not data.get("success"):
            return []

        result = data.get("result", [])
        reports = []
        if isinstance(result, list):
            reports = result
        elif isinstance(result, dict):
            for key in ("reports", "items", "abuse_reports"):
                if key in result:
                    reports = result[key] or []
                    break
            else:
                if "id" in result:
                    reports = [result]

        out = []
        for rep in reports:
            if not isinstance(rep, dict):
                continue
            # extract domain
            domain = (rep.get("domain") or rep.get("zone_name") or
                      rep.get("hostname") or rep.get("host") or "")
            if not domain:
                urls = rep.get("urls", [])
                if isinstance(urls, list) and urls:
                    from urllib.parse import urlparse
                    first = urls[0]
                    if isinstance(first, dict):
                        first = first.get("url") or first.get("target") or ""
                    from urllib.parse import urlparse as _up
                    domain = _up(str(first)).netloc or "unknown"
            out.append({
                "id": rep.get("id"),
                "domain": domain or "unknown",
                "type": rep.get("type"),
                "original_work": rep.get("original_work"),
                "reason": format_abuse_reason(rep.get("type"), rep.get("original_work")),
                "status": rep.get("status"),
                "created_at": rep.get("cdate") or rep.get("created_on") or rep.get("created_at"),
                "cf_account": account.name,
                "mitigation": rep.get("mitigation_summary"),
            })
        return out
    except Exception as e:
        _abuse_log.error(f"[cf_abuse] {account.name}: {e}")
        return []


# Live CF abuse-reports are slow to fetch (one HTTP round-trip per active CF
# account) and were being re-fetched on every Dashboard load — both the abuse
# widget and the "Причини банів" stats card called this independently, so a
# single page load could trigger the full live scan twice. Cache the combined
# result and refresh it once an hour via `cf_abuse_refresh_job` (main.py)
# instead. `_cf_abuse_lock` prevents a fetch stampede if several requests
# land while the cache is still empty right after a fresh deploy.
_cf_abuse_cache: dict = {"reports": [], "updated_at": None}
_cf_abuse_lock = _asyncio.Lock()


async def refresh_cf_abuse_cache(db: AsyncSession) -> list[dict]:
    """Live-fetch abuse reports for all active CF accounts and cache them."""
    async with _cf_abuse_lock:
        result = await db.execute(
            select(CloudflareAccount).where(CloudflareAccount.is_active == True)
        )
        accounts = result.scalars().all()
        all_reports = await _asyncio.gather(*[_fetch_cf_abuse(acc) for acc in accounts])
        combined = [r for sublist in all_reports for r in sublist]
        combined.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        _cf_abuse_cache["reports"] = combined
        _cf_abuse_cache["updated_at"] = datetime.now(timezone.utc)
        return combined


@router.get("/cf-abuse-reports", dependencies=[Depends(get_current_user)])
async def get_cf_abuse_reports(db: AsyncSession = Depends(get_db)):
    """Serve the hourly-refreshed cache. Falls back to a live fetch only if
    the cache has never been populated yet (fresh deploy, before the first
    scheduled run)."""
    if _cf_abuse_cache["updated_at"] is None:
        return await refresh_cf_abuse_cache(db)
    return _cf_abuse_cache["reports"]


@router.get("/cf-abuse-reports/refreshed-at", dependencies=[Depends(get_current_user)])
async def cf_abuse_reports_refreshed_at():
    return {"updated_at": _cf_abuse_cache["updated_at"]}
