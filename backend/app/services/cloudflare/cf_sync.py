"""
cf_sync.py — синхронізація доменів з Cloudflare в БД.
Запускається автоматично 1 раз на день + вручну через API.
DNS записи кожного акаунту завантажуються паралельно (до 25 одночасно).
"""
import asyncio
import logging
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    CloudflareAccount, Domain, DomainStatus, RecordType, ActionLog, AbuseAlert
)
from app.services.cloudflare.cf_zones import fetch_zones, fetch_dns_records, verify_account

logger = logging.getLogger(__name__)

# Max parallel DNS requests per account
_CONCURRENCY = 25


def _parse_status(raw: str) -> DomainStatus:
    return {
        "active": DomainStatus.active,
        "pending": DomainStatus.pending,
        "paused": DomainStatus.suspended,
        "deactivated": DomainStatus.suspended,
    }.get(raw, DomainStatus.unknown)


async def _fetch_zone_dns(zone: dict, email: str, api_key: str, sem: asyncio.Semaphore) -> tuple[dict, list]:
    """Fetch DNS records for one zone, respecting concurrency semaphore."""
    async with sem:
        try:
            records = await fetch_dns_records(email, api_key, zone["id"])
            return zone, records
        except Exception:
            return zone, []


async def sync_account(account: CloudflareAccount, db: AsyncSession) -> dict:
    """Sync all zones for one CF account. DNS requests run in parallel."""
    stats = {"created": 0, "updated": 0, "errors": 0, "account": account.name}

    # verify_account may fail for limited-scope tokens (cfk_ etc.) that can't
    # access /user/tokens/verify or /accounts — so we try fetch_zones directly
    # and only mark inactive if zones fetch itself fails.
    is_valid, info = await verify_account(account.email, account.api_key)
    if not is_valid:
        logger.warning(f"[sync] Account {account.name} verify failed ({info}), trying fetch_zones anyway...")

    try:
        zones = await fetch_zones(account.email, account.api_key)
    except Exception as e:
        logger.error(f"[sync] fetch_zones error for {account.name}: {e}")
        account.is_active = False
        await db.flush()
        stats["errors"] += 1
        return stats

    if not account.is_active:
        account.is_active = True

    # Fetch DNS records for all zones in parallel
    sem = asyncio.Semaphore(_CONCURRENCY)
    zone_dns_pairs = await asyncio.gather(
        *[_fetch_zone_dns(z, account.email, account.api_key, sem) for z in zones]
    )
    logger.info(f"[sync] {account.name}: fetched DNS for {len(zones)} zones in parallel")

    # Process DB updates sequentially (session is not concurrency-safe)
    from app.services.cloudflare.cf_dns import detect_keitaro_direct
    now = datetime.now(timezone.utc)

    for zone, dns_records in zone_dns_pairs:
        try:
            zone_id = zone["id"]
            zone_name = zone["name"]
            zone_status = _parse_status(zone.get("status", "unknown"))

            registered_at = None
            if zone.get("created_on"):
                try:
                    registered_at = datetime.fromisoformat(zone["created_on"].replace("Z", "+00:00"))
                except Exception:
                    pass

            main_type = None
            main_value = None
            direct_to_kt = False

            for rec in dns_records:
                if rec.get("name") == zone_name and rec.get("type") in ("A", "CNAME"):
                    main_type = RecordType(rec["type"])
                    main_value = rec["content"]
                    if rec.get("type") == "A":
                        direct_to_kt = await detect_keitaro_direct(rec["content"], db)
                    break

            result = await db.execute(select(Domain).where(Domain.zone_id == zone_id))
            domain = result.scalar_one_or_none()

            ns_list = zone.get("name_servers", [])
            ns_str = ",".join(ns_list) if ns_list else None

            if domain:
                prev_status = domain.zone_status
                domain.zone_status = zone_status
                domain.main_record_type = main_type
                domain.main_record_value = main_value
                domain.direct_to_keitaro = direct_to_kt
                domain.last_checked_at = now
                if ns_str:
                    domain.name_servers = ns_str
                stats["updated"] += 1

                # Create abuse alert if zone became suspended (or was already suspended without alert)
                if zone_status == DomainStatus.suspended:
                    existing = await db.execute(
                        select(AbuseAlert).where(
                            AbuseAlert.domain_id == domain.id,
                            AbuseAlert.resolved == False,
                        )
                    )
                    if not existing.scalar_one_or_none():
                        db.add(AbuseAlert(
                            domain_id=domain.id,
                            previous_status=prev_status,
                            new_status=zone_status,
                            resolved=False,
                        ))
                        stats.setdefault("abuses", 0)
                        stats["abuses"] += 1
            else:
                db.add(Domain(
                    cf_account_id=account.id,
                    zone_id=zone_id,
                    name=zone_name,
                    zone_status=zone_status,
                    registered_at=registered_at,
                    main_record_type=main_type,
                    main_record_value=main_value,
                    direct_to_keitaro=direct_to_kt,
                    last_checked_at=now,
                    name_servers=ns_str,
                ))
                stats["created"] += 1

        except Exception as e:
            logger.error(f"[sync] zone error {zone.get('name')}: {e}")
            stats["errors"] += 1

    account.last_synced_at = now
    await db.flush()
    logger.info(f"[sync] {account.name}: +{stats['created']} new, ~{stats['updated']} updated, {stats['errors']} errors")
    return stats


async def sync_all_accounts(db: AsyncSession) -> dict:
    """Sync all active CF accounts. Called by daily scheduler."""
    result = await db.execute(
        select(CloudflareAccount).where(CloudflareAccount.is_active == True)
    )
    accounts = result.scalars().all()
    total = {"created": 0, "updated": 0, "errors": 0, "accounts": len(accounts)}

    for account in accounts:
        stats = await sync_account(account, db)
        total["created"] += stats["created"]
        total["updated"] += stats["updated"]
        total["errors"] += stats["errors"]

    db.add(ActionLog(
        action="daily_sync",
        details=f"Synced {len(accounts)} accounts: +{total['created']} new, ~{total['updated']} updated",
    ))
    await db.flush()
    return total
