"""
kt_sync.py — синхронізація груп з Keitaro в БД.
"""
import httpx
import logging
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import KeitaroInstance, KeitaroDomainGroup

logger = logging.getLogger(__name__)
TIMEOUT = 20


def _headers(api_key: str) -> dict:
    return {"Api-Key": api_key, "Content-Type": "application/json", "Accept": "application/json"}


def _base(url: str) -> str:
    return f"{url.rstrip('/')}/admin_api/v1"


async def sync_groups(instance: KeitaroInstance, db: AsyncSession) -> int:
    # Keitaro embeds group info in each domain object (group_id + group name)
    # so we extract unique groups from the domains endpoint
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            r = await client.get(
                f"{_base(instance.url)}/domains",
                headers=_headers(instance.api_key),
            )
    except Exception as e:
        logger.warning(f"[kt_sync] {instance.name} connection error: {e}")
        return 0

    if r.status_code != 200:
        logger.warning(f"[kt_sync] {instance.name} unreachable: HTTP {r.status_code}")
        return 0

    instance.is_active = True
    domains = r.json() if isinstance(r.json(), list) else []

    # Extract unique {group_id: group_name} pairs
    seen: dict[str, str] = {}
    for d in domains:
        gid = d.get("group_id")
        gname = d.get("group")
        if gid and gname:
            seen[str(gid)] = gname

    count = 0
    for kt_gid, name in seen.items():
        result = await db.execute(
            select(KeitaroDomainGroup).where(
                KeitaroDomainGroup.keitaro_instance_id == instance.id,
                KeitaroDomainGroup.kt_group_id == kt_gid,
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.name = name
            existing.synced_at = datetime.now(timezone.utc)
        else:
            db.add(KeitaroDomainGroup(
                keitaro_instance_id=instance.id,
                kt_group_id=kt_gid,
                name=name,
                synced_at=datetime.now(timezone.utc),
            ))
        count += 1

    await db.flush()
    logger.info(f"[kt_sync] {instance.name}: synced {count} groups from {len(domains)} domains")
    return count


async def sync_all_instances(db: AsyncSession) -> dict:
    result = await db.execute(select(KeitaroInstance))
    instances = result.scalars().all()
    total = 0
    errors = []
    for inst in instances:
        try:
            count = await sync_groups(inst, db)
            total += count
        except Exception as e:
            errors.append({"instance": inst.name, "error": str(e)})
    return {"total_groups": total, "errors": errors}
