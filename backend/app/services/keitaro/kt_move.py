"""
kt_move.py — перенос домену між групами або між Keitaro інстансами.

Перенос між групами (той самий KT):
  - оновлює group_id через PUT /domains/{id}

Перенос між інстансами (різні KT):
  - видаляє з старого KT
  - видаляє старий CNAME (що вказує на старий KT)
  - додає в новий KT
  - створює новий CNAME на новий KT (якщо передано cname_target)
"""
import httpx
import logging
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Domain, KeitaroInstance, KeitaroDomainGroup, ActionLog, CloudflareAccount
)
from app.services.cloudflare.cf_dns import swap_main_record

logger = logging.getLogger(__name__)
TIMEOUT = 20


def _headers(api_key: str) -> dict:
    return {"Api-Key": api_key, "Content-Type": "application/json", "Accept": "application/json"}


def _base(url: str) -> str:
    return f"{url.rstrip('/')}/admin_api/v1"


async def _get_kt_domain_id(instance: KeitaroInstance, domain_name: str) -> int | None:
    async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
        r = await client.get(f"{_base(instance.url)}/domains", headers=_headers(instance.api_key))
        if r.status_code == 200:
            for d in r.json():
                if (d.get("name") or "").lower() == domain_name.lower():
                    return d.get("id")
    return None


async def move_to_group(
    domain: Domain,
    new_group: KeitaroDomainGroup,
    db: AsyncSession,
    user: str = "system",
) -> dict:
    """Move domain to another group within the SAME Keitaro instance."""
    if not domain.keitaro_group_id:
        return {"status": "error", "domain": domain.name, "detail": "Domain not linked to any KT group"}

    old_group_result = await db.execute(
        select(KeitaroDomainGroup).where(KeitaroDomainGroup.id == domain.keitaro_group_id)
    )
    old_group = old_group_result.scalar_one_or_none()
    if not old_group:
        return {"status": "error", "domain": domain.name, "detail": "Old group not found"}

    instance = await db.get(KeitaroInstance, old_group.keitaro_instance_id)
    if not instance:
        return {"status": "error", "domain": domain.name, "detail": "KT instance not found"}

    kt_domain_id = await _get_kt_domain_id(instance, domain.name)
    if not kt_domain_id:
        return {"status": "error", "domain": domain.name, "detail": f"Domain not found in KT {instance.name}"}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            r = await client.put(
                f"{_base(instance.url)}/domains/{kt_domain_id}",
                headers=_headers(instance.api_key),
                json={"group_id": int(new_group.kt_group_id)},
            )
        if r.status_code == 200:
            domain.keitaro_group_id = new_group.id
            db.add(ActionLog(
                action="kt_move_group",
                user=user,
                domain=domain.name,
                details=f"Moved from {old_group.name} → {new_group.name} in {instance.name}",
            ))
            await db.flush()
            return {"status": "ok", "domain": domain.name, "moved_to": new_group.name}
        else:
            return {"status": "error", "domain": domain.name, "detail": str(r.json())}
    except Exception as e:
        return {"status": "error", "domain": domain.name, "detail": str(e)}


async def move_to_instance(
    domain: Domain,
    new_instance: KeitaroInstance,
    new_group: KeitaroDomainGroup,
    new_cname_target: str,
    db: AsyncSession,
    user: str = "system",
) -> dict:
    """
    Move domain to a DIFFERENT Keitaro instance:
    1. Remove from old KT
    2. Swap CNAME on CF to point to new KT
    3. Add to new KT
    """
    old_group = None
    old_instance = None

    if domain.keitaro_group_id:
        old_group_result = await db.execute(
            select(KeitaroDomainGroup).where(KeitaroDomainGroup.id == domain.keitaro_group_id)
        )
        old_group = old_group_result.scalar_one_or_none()
        if old_group:
            old_instance = await db.get(KeitaroInstance, old_group.keitaro_instance_id)

    steps = []

    # Step 1: Remove from old KT
    if old_instance:
        try:
            kt_domain_id = await _get_kt_domain_id(old_instance, domain.name)
            if kt_domain_id:
                async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
                    r = await client.delete(
                        f"{_base(old_instance.url)}/domains/{kt_domain_id}",
                        headers=_headers(old_instance.api_key),
                    )
                steps.append(f"Removed from {old_instance.name}: {r.status_code in (200, 204)}")
            else:
                steps.append(f"Not found in old KT {old_instance.name} — skipped")
        except Exception as e:
            steps.append(f"Error removing from old KT: {e}")

    # Step 2: Swap CNAME on CF
    cf_result = await db.execute(
        select(CloudflareAccount).where(CloudflareAccount.id == domain.cf_account_id)
    )
    account = cf_result.scalar_one_or_none()
    if account:
        dns_result = await swap_main_record(domain, account, "CNAME", new_cname_target, True, db)
        steps.append(f"CF CNAME → {new_cname_target}: {dns_result['status']}")
    else:
        steps.append("CF account not found — DNS not changed")

    # Step 3: Add to new KT
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, verify=False) as client:
            r = await client.post(
                f"{_base(new_instance.url)}/domains",
                headers=_headers(new_instance.api_key),
                json={"name": domain.name, "group_id": int(new_group.kt_group_id)},
            )
        if r.status_code in (200, 201):
            domain.keitaro_group_id = new_group.id
            steps.append(f"Added to {new_instance.name} / {new_group.name}: ok")
        else:
            steps.append(f"Add to new KT failed: {r.json()}")
    except Exception as e:
        steps.append(f"Error adding to new KT: {e}")

    db.add(ActionLog(
        action="kt_move_instance",
        user=user,
        domain=domain.name,
        details=" | ".join(steps),
    ))
    await db.flush()
    return {"status": "ok", "domain": domain.name, "steps": steps}
