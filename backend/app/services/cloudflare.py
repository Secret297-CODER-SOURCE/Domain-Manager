import httpx
from datetime import datetime, timezone

CF_API = "https://api.cloudflare.com/client/v4"


def _headers(email: str, api_key: str) -> dict:
    """Global API Key auth (X-Auth-Email + X-Auth-Key)"""
    return {
        "X-Auth-Email": email,
        "X-Auth-Key": api_key,
        "Content-Type": "application/json",
    }


async def fetch_zones(email: str, api_key: str) -> list[dict]:
    zones = []
    page = 1
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            r = await client.get(
                f"{CF_API}/zones",
                headers=_headers(email, api_key),
                params={"page": page, "per_page": 50},
            )
            data = r.json()
            if not data.get("success"):
                raise Exception(f"CF error: {data.get('errors')}")
            zones.extend(data.get("result", []))
            info = data.get("result_info", {})
            if page >= info.get("total_pages", 1):
                break
            page += 1
    return zones


async def fetch_dns_records(email: str, api_key: str, zone_id: str) -> list[dict]:
    records = []
    page = 1
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            r = await client.get(
                f"{CF_API}/zones/{zone_id}/dns_records",
                headers=_headers(email, api_key),
                params={"page": page, "per_page": 100},
            )
            data = r.json()
            records.extend(data.get("result", []))
            info = data.get("result_info", {})
            if page >= info.get("total_pages", 1):
                break
            page += 1
    return records


async def check_zone_status(email: str, api_key: str, zone_id: str) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{CF_API}/zones/{zone_id}",
            headers=_headers(email, api_key),
        )
        if r.status_code == 200:
            return r.json().get("result", {}).get("status", "unknown")
    return "unknown"


async def create_dns_record(email: str, api_key: str, zone_id: str, record_type: str, name: str, content: str, ttl: int = 1, proxied: bool = False) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{CF_API}/zones/{zone_id}/dns_records",
            headers=_headers(email, api_key),
            json={"type": record_type, "name": name, "content": content, "ttl": ttl, "proxied": proxied},
        )
        return r.json()


async def update_dns_record(email: str, api_key: str, zone_id: str, record_id: str, record_type: str, name: str, content: str, ttl: int = 1, proxied: bool = False) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.put(
            f"{CF_API}/zones/{zone_id}/dns_records/{record_id}",
            headers=_headers(email, api_key),
            json={"type": record_type, "name": name, "content": content, "ttl": ttl, "proxied": proxied},
        )
        return r.json()


async def delete_dns_record(email: str, api_key: str, zone_id: str, record_id: str) -> bool:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.delete(
            f"{CF_API}/zones/{zone_id}/dns_records/{record_id}",
            headers=_headers(email, api_key),
        )
        return r.status_code in (200, 204)


async def sync_account(account, db) -> dict:
    from sqlalchemy import select
    from app.models.models import Domain, DomainStatus, RecordType

    stats = {"created": 0, "updated": 0, "errors": 0}

    try:
        zones = await fetch_zones(account.email, account.api_key)
    except Exception as e:
        print(f"[CF sync error] {account.name}: {e}")
        stats["errors"] += 1
        return stats

    for zone in zones:
        zone_id = zone["id"]
        zone_name = zone["name"]

        status_map = {
            "active": DomainStatus.active,
            "pending": DomainStatus.pending,
            "paused": DomainStatus.suspended,
        }
        zone_status = status_map.get(zone.get("status", "unknown"), DomainStatus.unknown)

        registered_at = None
        if zone.get("created_on"):
            try:
                registered_at = datetime.fromisoformat(zone["created_on"].replace("Z", "+00:00"))
            except Exception:
                pass

        try:
            dns_records = await fetch_dns_records(account.email, account.api_key, zone_id)
        except Exception:
            dns_records = []

        main_type = None
        main_value = None
        for rec in dns_records:
            if rec.get("name") == zone_name and rec.get("type") in ("A", "CNAME"):
                main_type = RecordType(rec["type"])
                main_value = rec["content"]
                break

        result = await db.execute(select(Domain).where(Domain.zone_id == zone_id))
        domain = result.scalar_one_or_none()

        if domain:
            domain.zone_status = zone_status
            domain.main_record_type = main_type
            domain.main_record_value = main_value
            domain.last_checked_at = datetime.now(timezone.utc)
            stats["updated"] += 1
        else:
            domain = Domain(
                cf_account_id=account.id,
                zone_id=zone_id,
                name=zone_name,
                zone_status=zone_status,
                registered_at=registered_at,
                main_record_type=main_type,
                main_record_value=main_value,
                last_checked_at=datetime.now(timezone.utc),
            )
            db.add(domain)
            stats["created"] += 1

    account.last_synced_at = datetime.now(timezone.utc)
    await db.flush()
    return stats
