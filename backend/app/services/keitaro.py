"""
Keitaro API service.
Uses /admin_api/v1/ endpoint (as per actual Keitaro API)
"""
import httpx
from datetime import datetime, timezone

TIMEOUT = 20


def _headers(api_key: str) -> dict:
    return {
        "Api-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _base(url: str) -> str:
    return f"{url.rstrip('/')}/admin_api/v1"


async def get_groups(base_url: str, api_key: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(
            f"{_base(base_url)}/domains/groups",
            headers=_headers(api_key),
        )
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []


async def get_domains(base_url: str, api_key: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(
            f"{_base(base_url)}/domains",
            headers=_headers(api_key),
        )
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []


async def add_domain_to_group(base_url: str, api_key: str, domain: str, group_id: int) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(
            f"{_base(base_url)}/domains",
            headers=_headers(api_key),
            json={"name": domain, "group_id": group_id},
        )
        r.raise_for_status()
        return r.json()


async def move_domain_to_group(base_url: str, api_key: str, kt_domain_id: int, group_id: int) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.put(
            f"{_base(base_url)}/domains/{kt_domain_id}",
            headers=_headers(api_key),
            json={"group_id": group_id},
        )
        r.raise_for_status()
        return r.json()


async def delete_domain(base_url: str, api_key: str, kt_domain_id: int) -> bool:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.delete(
            f"{_base(base_url)}/domains/{kt_domain_id}",
            headers=_headers(api_key),
        )
        return r.status_code in (200, 204)


async def sync_groups(base_url: str, api_key: str, kt_instance_id: int, db) -> int:
    from sqlalchemy import select
    from app.models.models import KeitaroDomainGroup

    groups = await get_groups(base_url, api_key)
    count = 0
    for g in groups:
        kt_gid = str(g.get("id", ""))
        name = g.get("name", "Unnamed")
        if not kt_gid:
            continue

        result = await db.execute(
            select(KeitaroDomainGroup).where(
                KeitaroDomainGroup.keitaro_instance_id == kt_instance_id,
                KeitaroDomainGroup.kt_group_id == kt_gid,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.name = name
            existing.synced_at = datetime.now(timezone.utc)
        else:
            db.add(KeitaroDomainGroup(
                keitaro_instance_id=kt_instance_id,
                kt_group_id=kt_gid,
                name=name,
                synced_at=datetime.now(timezone.utc),
            ))
        count += 1

    await db.flush()
    return count
