"""Two-way binding between a Spreadsheet and an entity table.

Concept:
- Each Spreadsheet can be linked to ONE entity collection: domains, mail,
  servers, proxies, identities, purchases.
- `column_map` JSON: {"Header in sheet": "field_in_model", ...}
- direction:
    pull  → entity → sheet only (sheet shows live data)
    push  → sheet  → entity only (sheet is the source of truth)
    both  → bidirectional: pull on read, push on write

Storage format inside Spreadsheet.data is the fortune-sheet workbook (JSON
array of sheet objects). To keep the round-trip simple we maintain a
"data-rows" sheet (index 0) with a header row + plain cells.

This module exposes:
- GET    /api/sheet-sync/{sheet_id}            → current binding (or 404)
- POST   /api/sheet-sync/{sheet_id}            → create/replace binding
- DELETE /api/sheet-sync/{sheet_id}            → unbind
- POST   /api/sheet-sync/{sheet_id}/pull       → entity → sheet
- POST   /api/sheet-sync/{sheet_id}/push       → sheet → entity (returns diff)
- GET    /api/sheet-sync/entities              → entity catalog (fields)
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional, Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import (
    Spreadsheet, SheetBinding, User,
    MailAccount, RemoteServer, Proxy, Identity,
)


router = APIRouter(prefix="/api/sheet-sync", tags=["sheet-sync"])


# ── Entity catalog ──────────────────────────────────────────────────────

ENTITY_MAP: Dict[str, Dict[str, Any]] = {
    "mail":       {"model": MailAccount,  "fields": ["email", "label", "tags", "notes", "color", "last_unread", "last_total"]},
    "servers":    {"model": RemoteServer, "fields": ["label", "host", "port", "username", "tags", "notes", "web_url", "last_status"]},
    "proxies":    {"model": Proxy,        "fields": ["label", "type", "host", "port", "username", "country", "tags", "notes"]},
    "identities": {"model": Identity,     "fields": ["first_name", "last_name", "email", "username", "country", "phone"]},
}


# ── Schemas ─────────────────────────────────────────────────────────────

class BindingIn(BaseModel):
    entity: str
    direction: str = "both"  # pull | push | both
    column_map: Dict[str, str]


class BindingOut(BaseModel):
    sheet_id: int
    entity: str
    direction: str
    column_map: Dict[str, str]
    last_sync_at: Optional[datetime]
    last_error: Optional[str]


# ── Helpers ──────────────────────────────────────────────────────────────

async def _owned_sheet(db: AsyncSession, sid: int, user: User) -> Spreadsheet:
    s = await db.get(Spreadsheet, sid)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Таблиця не знайдена")
    return s


def _attr(obj: Any, name: str) -> Any:
    try:
        v = getattr(obj, name, None)
    except Exception:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def _build_sheet_payload(headers: List[str], rows: List[List[Any]]) -> str:
    """Build fortune-sheet workbook with a single sheet containing
    header row + data rows. celldata format: [{r,c,v:{v:value}}]."""
    celldata = []
    for c, h in enumerate(headers):
        celldata.append({"r": 0, "c": c, "v": {"v": h, "ct": {"fa": "General", "t": "s"},
                                                "bl": 1, "bg": "#1e2433", "fc": "#e7ecf3"}})
    for r, row in enumerate(rows, start=1):
        for c, val in enumerate(row):
            if val is None or val == "":
                continue
            celldata.append({"r": r, "c": c, "v": {"v": str(val), "ct": {"fa": "General", "t": "g"}}})
    workbook = [{
        "name": "Sheet1",
        "row": max(60, len(rows) + 5),
        "column": max(20, len(headers) + 4),
        "celldata": celldata,
        "config": {},
        "order": 0,
        "status": 1,
    }]
    return json.dumps(workbook, ensure_ascii=False)


def _parse_sheet_payload(raw: str) -> List[Dict[str, str]]:
    """Read first sheet of a fortune-sheet workbook into list of dict rows
    keyed by header text."""
    try:
        wb = json.loads(raw or "[]")
        if not wb: return []
        sheet = wb[0]
        cd = sheet.get("celldata") or []
        if not cd: return []
        max_r = max(c["r"] for c in cd)
        max_c = max(c["c"] for c in cd)
        grid: List[List[str]] = [["" for _ in range(max_c + 1)] for _ in range(max_r + 1)]
        for cell in cd:
            v = cell.get("v") or {}
            val = v.get("v") if isinstance(v, dict) else v
            grid[cell["r"]][cell["c"]] = "" if val is None else str(val)
        if not grid: return []
        headers = grid[0]
        out = []
        for row in grid[1:]:
            if not any(x.strip() for x in row):
                continue
            out.append({headers[i]: row[i] for i in range(min(len(headers), len(row)))})
        return out
    except Exception:
        return []


# ── Endpoints ───────────────────────────────────────────────────────────

@router.get("/entities")
async def list_entities(user: User = Depends(get_current_user)):
    return [{"key": k, "fields": v["fields"]} for k, v in ENTITY_MAP.items()]


@router.get("/{sheet_id}", response_model=BindingOut)
async def get_binding(sheet_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await _owned_sheet(db, sheet_id, user)
    b = (await db.execute(select(SheetBinding).where(SheetBinding.sheet_id == sheet_id))).scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Прив'язки немає")
    return BindingOut(
        sheet_id=b.sheet_id, entity=b.entity, direction=b.direction,
        column_map=json.loads(b.column_map or "{}"),
        last_sync_at=b.last_sync_at, last_error=b.last_error,
    )


@router.post("/{sheet_id}", response_model=BindingOut)
async def upsert_binding(sheet_id: int, data: BindingIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await _owned_sheet(db, sheet_id, user)
    if data.entity not in ENTITY_MAP:
        raise HTTPException(400, f"Невідома сутність: {data.entity}")
    if data.direction not in ("pull", "push", "both"):
        raise HTTPException(400, "direction має бути pull/push/both")
    b = (await db.execute(select(SheetBinding).where(SheetBinding.sheet_id == sheet_id))).scalar_one_or_none()
    if not b:
        b = SheetBinding(sheet_id=sheet_id)
        db.add(b)
    b.entity = data.entity
    b.direction = data.direction
    b.column_map = json.dumps(data.column_map, ensure_ascii=False)
    b.last_error = None
    await db.flush(); await db.refresh(b)
    return BindingOut(
        sheet_id=b.sheet_id, entity=b.entity, direction=b.direction,
        column_map=json.loads(b.column_map),
        last_sync_at=b.last_sync_at, last_error=b.last_error,
    )


@router.delete("/{sheet_id}")
async def delete_binding(sheet_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await _owned_sheet(db, sheet_id, user)
    b = (await db.execute(select(SheetBinding).where(SheetBinding.sheet_id == sheet_id))).scalar_one_or_none()
    if b:
        await db.delete(b)
    return {"ok": True}


@router.post("/{sheet_id}/pull")
async def pull(sheet_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Materialize entity rows into the spreadsheet (overwrites Sheet1)."""
    sheet = await _owned_sheet(db, sheet_id, user)
    b = (await db.execute(select(SheetBinding).where(SheetBinding.sheet_id == sheet_id))).scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Спершу налаштуйте прив'язку")
    spec = ENTITY_MAP.get(b.entity)
    if not spec:
        raise HTTPException(400, "Невідома сутність")
    cmap = json.loads(b.column_map or "{}")
    if not cmap:
        raise HTTPException(400, "Порожня карта колонок")
    Model = spec["model"]
    rows_orm = (await db.execute(select(Model).where(Model.owner_user_id == user.id))).scalars().all()
    headers = list(cmap.keys()) + ["__id"]
    rows: List[List[Any]] = []
    for r in rows_orm:
        rows.append([_attr(r, cmap[h]) for h in cmap.keys()] + [r.id])
    sheet.data = _build_sheet_payload(headers, rows)
    b.last_sync_at = datetime.now(timezone.utc); b.last_error = None
    await db.flush()
    return {"ok": True, "rows": len(rows)}


@router.post("/{sheet_id}/push")
async def push(sheet_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Write sheet rows back into entity table. Uses __id column for matching;
    rows without __id are created. Returns counts of created/updated/skipped."""
    sheet = await _owned_sheet(db, sheet_id, user)
    b = (await db.execute(select(SheetBinding).where(SheetBinding.sheet_id == sheet_id))).scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Спершу налаштуйте прив'язку")
    spec = ENTITY_MAP.get(b.entity)
    if not spec:
        raise HTTPException(400, "Невідома сутність")
    cmap = json.loads(b.column_map or "{}")
    if not cmap:
        raise HTTPException(400, "Порожня карта колонок")
    Model = spec["model"]
    parsed = _parse_sheet_payload(sheet.data or "[]")
    created = updated = skipped = 0
    errors: List[str] = []

    insp = sa_inspect(Model)
    valid_cols = {c.key for c in insp.mapper.column_attrs}

    for row in parsed:
        try:
            payload = {}
            for header, field in cmap.items():
                if field not in valid_cols:
                    continue
                val = row.get(header)
                if val is None or val == "":
                    continue
                payload[field] = val
            rid_raw = row.get("__id")
            rid = None
            try: rid = int(rid_raw) if rid_raw else None
            except Exception: rid = None
            if rid:
                obj = await db.get(Model, rid)
                if obj and getattr(obj, "owner_user_id", None) == user.id:
                    for k, v in payload.items():
                        setattr(obj, k, v)
                    updated += 1
                else:
                    skipped += 1
            else:
                payload["owner_user_id"] = user.id
                # Per-entity required-field nudges
                if b.entity == "servers" and "label" not in payload:
                    payload["label"] = payload.get("host", "new")
                obj = Model(**payload)
                db.add(obj)
                created += 1
        except Exception as e:
            errors.append(str(e)[:200])
            skipped += 1

    b.last_sync_at = datetime.now(timezone.utc)
    b.last_error = "; ".join(errors[:3]) if errors else None
    await db.flush()
    return {"ok": True, "created": created, "updated": updated, "skipped": skipped, "errors": errors[:5]}
