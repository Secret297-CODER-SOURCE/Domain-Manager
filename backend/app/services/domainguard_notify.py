"""Push abuse/removal notifications out to registered BurnCheck instances.

Per-team, not global: each team can register one or more BurnCheck instances
(app.models.models.BurncheckInstance, managed via /api/teams/{id}/burncheck-
instances) with their own webhook_url + api_key. On a notable domain event
(zone suspended, zone removed from CF) we POST to every instance registered
for that domain's team, authenticated with X-API-Key: <instance.api_key> so
BurnCheck can recognize which of its keys the push came under.

Fires from services/telegram_bot.py (check_all_zones, on suspend) and from
api/domains.py (on soft/full delete). Best-effort: failures are logged, never
raised, so a BurnCheck outage can't break the abuse-check job or a deletion.
"""
import logging
import httpx
from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import BurncheckInstance

logger = logging.getLogger(__name__)


async def notify_domainguard_abuse(*, team_id: int, domain: str,
                                    cf_account_email: str | None,
                                    severity: str, category: str, message: str) -> None:
    payload = {
        "domain": domain,
        "cf_account_email": cf_account_email,
        "severity": severity,
        "category": category,
        "message": message,
    }

    # Own short-lived session — this runs detached via asyncio.create_task
    # from callers whose own session may already be closed/committed by
    # the time this executes, so it can't safely share their `db`.
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(BurncheckInstance).where(
                BurncheckInstance.team_id == team_id,
                BurncheckInstance.webhook_url.isnot(None),
            )
        )
        instances = result.scalars().all()

    async with httpx.AsyncClient(timeout=8) as client:
        for inst in instances:
            try:
                await client.post(inst.webhook_url, json=payload,
                                   headers={"X-API-Key": inst.api_key})
            except Exception:
                logger.exception("[domainguard_notify] failed to push %s for %s (instance=%s)",
                                  category, domain, inst.label)

        # Legacy global fallback — kept for any deployment still relying on
        # a single shared webhook instead of per-team instances.
        if settings.DOMAINGUARD_WEBHOOK_URL:
            try:
                await client.post(
                    settings.DOMAINGUARD_WEBHOOK_URL, json=payload,
                    headers={"X-Webhook-Secret": settings.DOMAINGUARD_WEBHOOK_SECRET or ""},
                )
            except Exception:
                logger.exception("[domainguard_notify] failed to push %s for %s (legacy global)",
                                  category, domain)
