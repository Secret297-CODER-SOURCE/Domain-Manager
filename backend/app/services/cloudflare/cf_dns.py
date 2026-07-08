"""
cf_dns.py — операції з DNS записами.
- Індивідуальне додавання/видалення
- Масова зміна CNAME/A для списку доменів
- Попередження якщо домен напряму на KT (A запис на IP кейтаро)
- Повне видалення зони з CF
"""
import logging
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Domain, CloudflareAccount, DnsRecord, RecordType, ActionLog
from app.services.cloudflare.cf_zones import (
    make_headers, fetch_dns_records, CF_API, TIMEOUT
)
import httpx

logger = logging.getLogger(__name__)


async def detect_keitaro_direct(ip: str, db: AsyncSession) -> bool:
    """Check if an IP belongs to any known Keitaro instance."""
    from app.models.models import KeitaroInstance
    import re
    # Extract IP from URL
    result = await db.execute(select(KeitaroInstance))
    instances = result.scalars().all()
    for inst in instances:
        # Extract host from URL
        host = re.sub(r"https?://", "", inst.url).split("/")[0].split(":")[0]
        if host == ip:
            return True
    return False


async def create_record(
    email: str, api_key: str, zone_id: str,
    record_type: str, name: str, content: str,
    ttl: int = 1, proxied: bool = True
) -> dict:
    headers = make_headers(email, api_key)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(
            f"{CF_API}/zones/{zone_id}/dns_records",
            headers=headers,
            json={"type": record_type, "name": name, "content": content, "ttl": ttl, "proxied": proxied},
        )
        return r.json()


async def update_record(
    email: str, api_key: str, zone_id: str, record_id: str,
    record_type: str, name: str, content: str,
    ttl: int = 1, proxied: bool = True
) -> dict:
    headers = make_headers(email, api_key)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.put(
            f"{CF_API}/zones/{zone_id}/dns_records/{record_id}",
            headers=headers,
            json={"type": record_type, "name": name, "content": content, "ttl": ttl, "proxied": proxied},
        )
        return r.json()


async def delete_record(email: str, api_key: str, zone_id: str, record_id: str) -> bool:
    headers = make_headers(email, api_key)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.delete(
            f"{CF_API}/zones/{zone_id}/dns_records/{record_id}",
            headers=headers,
        )
        return r.status_code in (200, 204)


async def delete_all_dns_records(email: str, api_key: str, zone_id: str) -> int:
    """Delete ALL DNS records from a zone (for abuse handling)."""
    records = await fetch_dns_records(email, api_key, zone_id)
    deleted = 0
    for rec in records:
        rec_type = rec.get("type", "")
        if rec_type in ("NS", "SOA"):
            continue
        ok = await delete_record(email, api_key, zone_id, rec["id"])
        if ok:
            deleted += 1
    return deleted


async def delete_full_zone_from_cf(email: str, api_key: str, zone_id: str) -> bool:
    """Fully remove zone from Cloudflare."""
    from app.services.cloudflare.cf_zones import delete_zone
    return await delete_zone(email, api_key, zone_id)


async def swap_main_record(
    domain: Domain,
    account: CloudflareAccount,
    new_type: str,
    new_value: str,
    proxied: bool = True,
    db: AsyncSession = None,
) -> dict:
    """
    Replace the main A or CNAME record for a domain.
    Deletes all existing A/CNAME on root, then creates new one.
    Returns {"status": "ok"|"error", "domain": ..., "detail": ...}
    """
    # Warning: A record pointing directly to KT
    if new_type == "A" and db:
        is_direct = await detect_keitaro_direct(new_value, db)
        if is_direct:
            logger.warning(f"[dns] {domain.name}: A record pointing directly to Keitaro IP {new_value}!")

    try:
        existing = await fetch_dns_records(account.email, account.api_key, domain.zone_id)
        for rec in existing:
            if rec.get("name") == domain.name and rec.get("type") in ("A", "CNAME"):
                await delete_record(account.email, account.api_key, domain.zone_id, rec["id"])

        resp = await create_record(
            account.email, account.api_key, domain.zone_id,
            new_type, "@", new_value, 1, proxied
        )

        if resp.get("success"):
            if db:
                # Update DB
                domain.main_record_type = RecordType(new_type)
                domain.main_record_value = new_value
                # Remove old cached records, add new
                old = await db.execute(
                    select(DnsRecord).where(
                        DnsRecord.domain_id == domain.id,
                        DnsRecord.name == domain.name,
                    )
                )
                for r in old.scalars().all():
                    if r.record_type in (RecordType.A, RecordType.CNAME):
                        await db.delete(r)
                db.add(DnsRecord(
                    domain_id=domain.id,
                    cf_record_id=resp["result"]["id"],
                    record_type=RecordType(new_type),
                    name=domain.name,
                    value=new_value,
                    proxied=proxied,
                ))
                await db.flush()
            ns_list = domain.name_servers.split(",") if domain.name_servers else []
            return {"status": "ok", "domain": domain.name, "name_servers": ns_list}
        else:
            return {"status": "error", "domain": domain.name, "detail": str(resp.get("errors"))}

    except Exception as e:
        return {"status": "error", "domain": domain.name, "detail": str(e)}


async def bulk_swap_records(
    domain_ids: list[int],
    new_type: str,
    new_value: str,
    proxied: bool,
    db: AsyncSession,
    user: str = "system",
) -> dict:
    """
    Bulk change main DNS record for a list of domains.
    Warns about A records pointing to KT directly.
    """
    result = await db.execute(
        select(Domain, CloudflareAccount)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .where(Domain.id.in_(domain_ids))
    )
    rows = result.all()

    results = []
    warnings = []

    # Check for direct KT pointing
    if new_type == "A":
        is_direct = await detect_keitaro_direct(new_value, db)
        if is_direct:
            warnings.append(f"[!] IP {new_value} належить Keitaro інстансу — домени будуть направлені напряму на KT без проксі.")

    for domain, account in rows:
        r = await swap_main_record(domain, account, new_type, new_value, proxied, db)
        results.append(r)

    ok_count = sum(1 for r in results if r["status"] == "ok")
    err_count = len(results) - ok_count

    # Log action
    db.add(ActionLog(
        action="bulk_dns_swap",
        user=user,
        details=f"{new_type} → {new_value} | OK: {ok_count}, ERR: {err_count} | domains: {[r['domain'] for r in results]}",
    ))
    await db.flush()

    return {
        "ok": ok_count,
        "errors": err_count,
        "warnings": warnings,
        "results": results,
    }
