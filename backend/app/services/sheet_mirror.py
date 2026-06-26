"""Auto-mirror entity changes into any bound spreadsheet.

Called from CRUD endpoints (mail, servers, proxies, identities) so when the
user changes data on a page, the linked Google-Sheets-style table reflects
the change immediately.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


# Lazy imports inside the function to avoid circular imports at startup.

async def mirror_entity_to_sheets(db: AsyncSession, *, entity_kind: str, owner_user_id: int) -> None:
    """Re-materialize entity → all bound sheets for this user. No-op when no
    binding exists. Best-effort; swallows errors so caller is never blocked."""
    try:
        from app.models.models import (
            SheetBinding, Spreadsheet,
            MailAccount, RemoteServer, Proxy, Identity,
        )
        from app.api.sheet_sync import _build_sheet_payload, _attr

        MAP = {
            "mail": MailAccount, "servers": RemoteServer,
            "proxies": Proxy, "identities": Identity,
        }
        Model = MAP.get(entity_kind)
        if not Model:
            return

        # find bindings for this entity that belong to this user's sheets
        q = (
            select(SheetBinding, Spreadsheet)
            .join(Spreadsheet, Spreadsheet.id == SheetBinding.sheet_id)
            .where(SheetBinding.entity == entity_kind,
                   Spreadsheet.owner_user_id == owner_user_id,
                   SheetBinding.direction.in_(("pull", "both")))
        )
        pairs = (await db.execute(q)).all()
        if not pairs:
            return

        rows_orm = (await db.execute(
            select(Model).where(Model.owner_user_id == owner_user_id)
        )).scalars().all()

        # Pre-resolve team names so the sync `_attr("_team_name")` doesn't
        # need an await per row.
        if entity_kind == "servers":
            from app.models.models import Team as _Team
            teams = {t.id: t.name for t in (await db.execute(select(_Team))).scalars().all()}
            for r in rows_orm:
                r._resolved_team_name = teams.get(getattr(r, "team_id", None), "")

        for binding, sheet in pairs:
            try:
                cmap = json.loads(binding.column_map or "{}")
                if not cmap:
                    continue
                headers = list(cmap.keys()) + ["__id"]
                rows = [
                    [_attr(r, cmap[h]) for h in cmap.keys()] + [r.id]
                    for r in rows_orm
                ]
                if sheet.kind == "google" and sheet.external_url:
                    # Push to Google via service account. Wrapped in to_thread
                    # because gspread is blocking. Errors don't break the
                    # mirror — we record them for the user to investigate.
                    try:
                        import asyncio as _asyncio
                        from app.services.google_sheets_write import (
                            sync_to_google_sheet,
                        )
                        await _asyncio.to_thread(
                            sync_to_google_sheet, sheet.external_url, headers, rows,
                        )
                    except Exception as e:
                        binding.last_error = f"google: {e}"[:480]
                        continue
                else:
                    sheet.data = _build_sheet_payload(headers, rows)
                binding.last_sync_at = datetime.now(timezone.utc)
                binding.last_error = None
            except Exception as e:
                binding.last_error = str(e)[:480]
    except Exception:
        # Never let mirror failure break the original CRUD call
        pass
