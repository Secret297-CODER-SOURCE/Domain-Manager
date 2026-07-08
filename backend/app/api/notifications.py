"""In-panel notifications feed.

Backed by `ActionLog` so the data source is a single table — there's no
separate notifications schema to migrate. We surface specific `action`
values that represent things the user should *do*: pay for a server,
renew a domain. Adding a new actionable type is just a string + UI label.
"""
from __future__ import annotations
import json as _json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import ActionLog, User


router = APIRouter(prefix="/api/notifications", tags=["notifications"])

# Actions surfaced as user-facing notifications. Each maps to a kind shown
# in the UI bell — frontend decides icon/colour from the kind string.
ACTION_KINDS = {
    "server_payment_reminded": "server_payment",
    "domain_expiry_notified":  "domain_expiry",
    "payment_due_reminded":    "payment_due",
}

CATEGORY_LABELS = {
    "license": "Ліцензія", "klo": "КЛО", "server": "Сервер",
    "ai": "AI підписка", "vds": "ВДС", "other": "Оплата",
}


class NotificationOut(BaseModel):
    id: int
    kind: str
    title: str
    detail: Optional[str] = None
    target: Optional[str] = None
    created_at: datetime


@router.get("", response_model=list[NotificationOut])
async def list_notifications(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
    days: int = Query(7, ge=1, le=30),
    limit: int = Query(100, ge=1, le=500),
):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (await db.execute(
        select(ActionLog)
        .where(ActionLog.action.in_(list(ACTION_KINDS.keys())))
        .where(ActionLog.created_at >= cutoff)
        .order_by(ActionLog.created_at.desc())
        .limit(limit)
    )).scalars().all()

    out: list[NotificationOut] = []
    for r in rows:
        kind = ACTION_KINDS.get(r.action, "info")
        try:
            details = _json.loads(r.details or "null")
        except Exception:
            details = r.details

        if kind == "server_payment":
            d = details if isinstance(details, dict) else {}
            title = f"Оплата сервера: {r.domain or '—'}"
            detail_str = (
                f"Команда: {d.get('team', '—')} · "
                f"Провайдер: {d.get('provider') or '—'} · "
                f"{d.get('days_left', '?')}д до кінця місяця"
            )
        elif kind == "domain_expiry":
            d = details if isinstance(details, dict) else {}
            days = d.get("days_left")
            mark = (
                "сьогодні" if days is not None and days <= 0
                else "завтра" if days == 1
                else f"за {days}д" if days is not None
                else "невдовзі"
            )
            est = " (≈)" if d.get("estimated") else ""
            title = f"Продовжити домен: {r.domain or '—'}"
            detail_str = f"Завершується {mark}{est} · Команда: {d.get('team', '—')}"
        elif kind == "payment_due":
            d = details if isinstance(details, dict) else {}
            days = d.get("days_left")
            mark = (
                f"прострочено на {-days}д" if days is not None and days < 0
                else "сьогодні" if days == 0
                else "завтра" if days == 1
                else f"за {days}д" if days is not None
                else "невдовзі"
            )
            cat_label = CATEGORY_LABELS.get(d.get("category"), "Оплата")
            title = f"{cat_label}: {r.domain or '—'}"
            detail_str = (
                f"Оплатити {mark} · Провайдер: {d.get('provider') or '—'} · "
                f"Команда: {d.get('team') or '—'}"
            )
        else:
            title = r.action
            detail_str = str(details)[:200] if details else None

        out.append(NotificationOut(
            id=r.id, kind=kind, title=title, detail=detail_str,
            target=r.domain, created_at=r.created_at,
        ))
    return out
