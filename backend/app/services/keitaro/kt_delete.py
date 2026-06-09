"""
kt_delete.py — видалення домену з Keitaro.
"""
import httpx
import logging
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Domain, KeitaroInstance, KeitaroDomainGroup, ActionLog

logger = logging.getLogger(__name__)
TIMEOUT = 20


def _headers(api_key: str) -> dict:
    return {"Api-Key": api_key, "Content-Type": "application/json", "Accept": "application/json"}


def _base(url: str) -> str:
    return f"{url.rstrip('/')}/admin_api/v1"


async def delete_from_keitaro(
    domain: Domain,
    db: AsyncSession,
    user: str = "system",
) -> dict:
    """Remove domain from its linked Keitaro instance."""
    if not domain.keitaro_group_id:
        return {"status": "error", "domain": domain.name, "detail": "Not linked to any KT group"}

    old_group_result = await db.execute(
        select(KeitaroDomainGroup).where(KeitaroDomainGroup.id == domain.keitaro_group_id)
    )
    group = old_group_result.scalar_one_or_none()
    if not group:
        return {"status": "error", "domain": domain.name, "detail": "Group not found"}

    instance = await db.get(KeitaroInstance, group.keitaro_instance_id)
    if not instance:
        return {"status": "error", "domain": domain.name, "detail": "KT instance not found"}

    try:
        # Find domain id in KT
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            r = await client.get(f"{_base(instance.url)}/domains", headers=_headers(instance.api_key))
            kt_domain_id = None
            if r.status_code == 200:
                for d in r.json():
                    if (d.get("name") or "").lower() == domain.name.lower():
                        kt_domain_id = d.get("id")
                        break

            if not kt_domain_id:
                # Already gone from KT — just unlink in DB
                domain.keitaro_group_id = None
                db.add(ActionLog(
                    action="kt_delete_domain",
                    user=user,
                    domain=domain.name,
                    details=f"Not found in KT {instance.name} — unlinked from DB only",
                ))
                await db.flush()
                return {"status": "ok", "domain": domain.name, "detail": "Not in KT, unlinked from DB"}

            r2 = await client.delete(
                f"{_base(instance.url)}/domains/{kt_domain_id}",
                headers=_headers(instance.api_key),
            )

        if r2.status_code in (200, 204):
            domain.keitaro_group_id = None
            db.add(ActionLog(
                action="kt_delete_domain",
                user=user,
                domain=domain.name,
                details=f"Deleted from {instance.name} / {group.name}",
            ))
            await db.flush()
            return {"status": "ok", "domain": domain.name}
        else:
            return {"status": "error", "domain": domain.name, "detail": str(r2.json())}

    except Exception as e:
        logger.error(f"[kt_delete] {domain.name}: {e}")
        return {"status": "error", "domain": domain.name, "detail": str(e)}
