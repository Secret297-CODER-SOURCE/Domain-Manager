"""Centralised audit log helper.

Wraps `ActionLog` writes so every endpoint records *what happened, who did it,
which entity it touched, and details* in one place. Caller doesn't commit —
just `db.add` and let the request transaction handle it.
"""
from __future__ import annotations
import logging
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import ActionLog, User

logger = logging.getLogger("audit")


def log_action(
    db: AsyncSession,
    action: str,
    *,
    user: Optional[User | str] = None,
    target: Optional[str] = None,
    details: Optional[str | dict | list] = None,
) -> ActionLog:
    """Record an ActionLog row + emit structured log line.

    `action` — short snake_case verb (`identity_generate`, `cf_account_add`, …).
    `user` — either a User model, a username string, or None for system actions.
    `target` — what was touched (domain name, entity label). Goes into `domain`
               column to reuse the existing index.
    `details` — free-form. dict/list are JSON-serialised; truncated to 1KB.
    """
    if isinstance(user, User):
        username = user.username
    else:
        username = user or "system"

    if isinstance(details, (dict, list)):
        import json
        details_str = json.dumps(details, ensure_ascii=False, default=str)
    else:
        details_str = str(details) if details is not None else None

    if details_str and len(details_str) > 1024:
        details_str = details_str[:1021] + "…"

    log = ActionLog(action=action, user=username, domain=target, details=details_str)
    db.add(log)
    logger.info("[audit] %s by %s target=%s details=%s", action, username, target,
                (details_str or "")[:200])
    return log
