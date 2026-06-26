"""
kt_add.py — додавання домену в Keitaro групу.
"""
import httpx
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.models import Domain, KeitaroInstance, KeitaroDomainGroup, ActionLog

logger = logging.getLogger(__name__)
TIMEOUT = 20


def _headers(api_key: str) -> dict:
    return {"Api-Key": api_key, "Content-Type": "application/json", "Accept": "application/json"}


def _base(url: str) -> str:
    return f"{url.rstrip('/')}/admin_api/v1"


async def add_domain_to_group(
    domain: Domain,
    instance: KeitaroInstance,
    group,  # KeitaroDomainGroup | None
    db: AsyncSession,
    user: str = "system",
) -> dict:
    """Add domain to Keitaro instance, optionally to a specific group."""
    url = f"{_base(instance.url)}/domains"
    payload = {"name": domain.name, "https_only": True}
    if group is not None:
        payload["group_id"] = int(group.kt_group_id)

    group_label = group.name if group else "без групи"
    logger.info(f"[kt_add] POST {url} payload={payload} instance={instance.name}")
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            r = await client.post(url, headers=_headers(instance.api_key), json=payload)
        data = r.json()

        # Some KT versions don't support https_only in POST — retry without it, then PATCH
        https_only_via_patch = False
        if r.status_code == 422 and "https_only" in str(data):
            logger.info(f"[kt_add] {domain.name} — https_only not supported in POST, retrying without")
            payload.pop("https_only")
            async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
                r = await client.post(url, headers=_headers(instance.api_key), json=payload)
            data = r.json()
            https_only_via_patch = True  # will try to set via PATCH after creation

        logger.info(f"[kt_add] {domain.name} → HTTP {r.status_code} response={str(data)[:300]}")

        if r.status_code in (200, 201):
            if group is not None:
                domain.keitaro_group_id = group.id

            # Try to set https_only via PATCH if POST didn't support it
            if https_only_via_patch and isinstance(data, dict) and data.get("id"):
                kt_domain_id = data["id"]
                try:
                    async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
                        pr = await client.patch(
                            f"{url}/{kt_domain_id}",
                            headers=_headers(instance.api_key),
                            json={"https_only": True},
                        )
                    if pr.status_code in (200, 201):
                        logger.info(f"[kt_add] {domain.name} — https_only set via PATCH (ok)")
                    else:
                        logger.warning(f"[kt_add] {domain.name} — PATCH https_only failed: {pr.status_code}")
                except Exception as pe:
                    logger.warning(f"[kt_add] {domain.name} — PATCH https_only exception: {pe}")

            db.add(ActionLog(
                action="kt_add_domain",
                user=user,
                domain=domain.name,
                details=f"Added to {instance.name} / {group_label}",
            ))
            await db.flush()
            return {"status": "ok", "domain": domain.name, "group": group_label}
        else:
            detail = str(data)
            logger.warning(f"[kt_add] FAILED {domain.name}: HTTP {r.status_code} — {detail}")
            return {"status": "error", "domain": domain.name, "detail": detail}

    except Exception as e:
        logger.error(f"[kt_add] EXCEPTION {domain.name}: {e}")
        return {"status": "error", "domain": domain.name, "detail": str(e)}
