from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
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


@router.get("", response_model=list[DomainOut])
async def list_domains(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
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
    page: int = Query(1, ge=1),
    page_size: int = Query(100000, ge=1),
):
    q = (
        select(Domain, CloudflareAccount, Team,
               KeitaroDomainGroup, KeitaroInstance)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .join(Team, CloudflareAccount.team_id == Team.id)
        .outerjoin(KeitaroDomainGroup, Domain.keitaro_group_id == KeitaroDomainGroup.id)
        .outerjoin(KeitaroInstance, KeitaroDomainGroup.keitaro_instance_id == KeitaroInstance.id)
    )
    filters = []
    if team_id and team_id.strip():
        filters.append(Team.id == int(team_id))
    if cf_account_id and cf_account_id.strip():
        filters.append(CloudflareAccount.id == int(cf_account_id))
    if status and status.strip():
        filters.append(Domain.zone_status == DomainStatus(status))
    if zone and zone.strip():
        filters.append(Domain.name.like(f"%{zone}"))
    if search and search.strip():
        filters.append(Domain.name.ilike(f"%{search}%"))
    if keitaro_group_id and keitaro_group_id.strip():
        filters.append(Domain.keitaro_group_id == int(keitaro_group_id))
    if keitaro_instance_id and keitaro_instance_id.strip():
        filters.append(KeitaroInstance.id == int(keitaro_instance_id))
    if no_keitaro and no_keitaro not in ("false", "0", ""):
        filters.append(Domain.keitaro_group_id.is_(None))
    if cname_value and cname_value.strip():
        filters.append(Domain.main_record_value.ilike(f"%{cname_value}%"))
    if direct_to_kt and direct_to_kt not in ("false", "0", ""):
        filters.append(Domain.direct_to_keitaro == True)
    if filters:
        q = q.where(and_(*filters))
    q = q.order_by(Domain.name).offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(q)
    out = []
    for domain, account, team, kt_group, kt_inst in result.all():
        d = DomainOut.model_validate(domain)
        d.cf_account_name = account.name
        d.cf_account_active = account.is_active
        d.team_id = team.id
        d.team_name = team.name
        d.keitaro_group_name = kt_group.name if kt_group else None
        d.keitaro_instance_name = kt_inst.name if kt_inst else None
        out.append(d)
    return out


@router.get("/count")
async def count_domains(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(func.count(Domain.id)))
    return {"count": result.scalar()}


@router.post("/sync/{cf_account_id}", dependencies=[Depends(require_admin)])
async def sync_cf_account(cf_account_id: int, db: AsyncSession = Depends(get_db)):
    account = await db.get(CloudflareAccount, cf_account_id)
    if not account:
        raise HTTPException(404, "CF account not found")
    stats = await sync_account(account, db)
    await db.commit()
    return {"ok": True, "stats": stats}


@router.post("/sync-all", dependencies=[Depends(require_admin)])
async def sync_all(db: AsyncSession = Depends(get_db)):
    stats = await sync_all_accounts(db)
    await db.commit()
    return {"ok": True, "stats": stats}


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


class BulkAbuseDeleteRequest(BaseModel):
    domains: list[str]  # list of domain names

@router.post("/bulk-abuse-delete", dependencies=[Depends(require_admin)])
async def bulk_abuse_delete(data: BulkAbuseDeleteRequest, db: AsyncSession = Depends(get_db)):
    """Delete multiple domains from CF without OTP — for abuse report cleanup."""
    results = []
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
        await db.delete(domain)
        results.append({"domain": name, "ok": ok})
    await db.commit()
    return {"results": results}


@router.delete("/{domain_id}/full-delete", dependencies=[Depends(require_delete_token)])
async def full_delete_from_cf(domain_id: int, db: AsyncSession = Depends(get_db)):
    """Fully remove zone from Cloudflare AND from our DB."""
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
    ok = await delete_full_zone_from_cf(account.email, account.api_key, domain.zone_id)
    db.add(ActionLog(action="full_delete_cf", domain=domain.name, details=f"manual|{team.name}|{account.name}"))
    await db.delete(domain)
    await db.commit()
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


class AddToCFRequest(BaseModel):
    cf_account_id: int
    domains: list[str]


@router.post("/add-to-cf", dependencies=[Depends(require_admin)])
async def add_domains_to_cf(data: AddToCFRequest, db: AsyncSession = Depends(get_db)):
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
            )
            db.add(domain)
            db.add(ActionLog(action="cf_add_zone", domain=name, details=f"Added to {account.name}"))
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
    domain_ids = [d.id for d in result.scalars().all()]
    if not domain_ids:
        return {"ok": 0, "errors": 0, "warnings": [], "results": []}
    result = await bulk_swap_records(
        domain_ids, data.record_type.value, data.value, data.proxied, db, current_user.username
    )
    await db.commit()
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
    kt_instance_id: Optional[int] = None
    kt_group_id: Optional[int] = None


@router.post("/quick-add", dependencies=[Depends(require_admin)])
async def quick_add_domains(data: QuickAddRequest, db: AsyncSession = Depends(get_db)):
    """Add domains to CF, optionally set CNAME and add to KT group in one shot."""
    account = await db.get(CloudflareAccount, data.cf_account_id)
    if not account:
        raise HTTPException(404, "CF account not found")

    instance = await db.get(KeitaroInstance, data.kt_instance_id) if data.kt_instance_id else None
    group = await db.get(KeitaroDomainGroup, data.kt_group_id) if data.kt_group_id else None

    results = []
    for raw in data.domains:
        name = raw.strip().lower()
        if not name:
            continue
        item: dict = {"domain": name, "cf_status": None, "name_servers": [], "cname_set": False, "kt_added": False, "cf_error": None}

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
                )
                db.add(domain_obj)
                await db.flush()
                await db.refresh(domain_obj)  # ensure id is populated
                db.add(ActionLog(action="cf_add_zone", domain=name, details=f"quick-add to {account.name}"))
                item["cf_status"] = "added"
            else:
                errs = resp.get("errors", [])
                item["cf_status"] = "error"
                item["cf_error"] = errs[0].get("message", "CF error") if errs else "CF error"
                results.append(item)
                continue

        # Set CNAME → KT instance cname
        if instance and instance.cname and domain_obj and domain_obj.zone_id:
            cname_resp = await create_record(
                account.email, account.api_key, domain_obj.zone_id,
                "CNAME", name, instance.cname, ttl=1, proxied=True
            )
            if cname_resp.get("success"):
                item["cname_set"] = True
                domain_obj.main_record_type = RecordType.CNAME
                domain_obj.main_record_value = instance.cname

        # Add to KT (group is optional — None means no group)
        if instance and domain_obj and domain_obj.id:
            from app.services.keitaro.kt_add import add_domain_to_group
            kt_res = await add_domain_to_group(domain_obj, instance, group, db, "quick-add")
            item["kt_added"] = kt_res.get("status") == "ok"
            if not item["kt_added"]:
                item["kt_error"] = kt_res.get("detail", "KT error")

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
                    reports = result[key]
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
                "status": rep.get("status"),
                "created_at": rep.get("cdate") or rep.get("created_on") or rep.get("created_at"),
                "cf_account": account.name,
                "mitigation": rep.get("mitigation_summary"),
            })
        return out
    except Exception as e:
        _abuse_log.error(f"[cf_abuse] {account.name}: {e}")
        return []


@router.get("/cf-abuse-reports", dependencies=[Depends(get_current_user)])
async def get_cf_abuse_reports(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(CloudflareAccount).where(CloudflareAccount.is_active == True)
    )
    accounts = result.scalars().all()
    all_reports = await _asyncio.gather(*[_fetch_cf_abuse(acc) for acc in accounts])
    combined = [r for sublist in all_reports for r in sublist]
    # Sort by created_at desc
    combined.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    return combined
