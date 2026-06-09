from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

from app.db.session import get_db
from app.models.models import Spreadsheet, User
from app.core.security import get_current_user

router = APIRouter(prefix="/api/sheets", tags=["sheets"])


class SheetMeta(BaseModel):
    id: int
    name: str
    is_encrypted: bool = False
    updated_at: Optional[datetime]
    created_at: Optional[datetime]
    class Config:
        from_attributes = True


class SheetFull(SheetMeta):
    data: str


def _to_meta(s: Spreadsheet) -> SheetMeta:
    return SheetMeta(
        id=s.id, name=s.name,
        is_encrypted=bool(s.data and s.data.startswith("ENC1:")),
        updated_at=s.updated_at, created_at=s.created_at,
    )


def _to_full(s: Spreadsheet) -> SheetFull:
    return SheetFull(
        id=s.id, name=s.name, data=s.data,
        is_encrypted=bool(s.data and s.data.startswith("ENC1:")),
        updated_at=s.updated_at, created_at=s.created_at,
    )


class SheetCreate(BaseModel):
    name: str
    data: Optional[str] = None


class SheetUpdate(BaseModel):
    name: Optional[str] = None
    data: Optional[str] = None


@router.get("", response_model=list[SheetMeta])
async def list_sheets(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Spreadsheet).where(Spreadsheet.owner_user_id == user.id).order_by(Spreadsheet.updated_at.desc().nullslast(), Spreadsheet.id.desc())
    return [_to_meta(s) for s in (await db.execute(q)).scalars().all()]


@router.post("", response_model=SheetFull)
async def create_sheet(data: SheetCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = Spreadsheet(owner_user_id=user.id, name=data.name or "Без назви", data=data.data or "[]")
    db.add(s)
    await db.flush()
    await db.refresh(s)
    return _to_full(s)


@router.get("/{sheet_id}", response_model=SheetFull)
async def get_sheet(sheet_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await db.get(Spreadsheet, sheet_id)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Sheet not found")
    return _to_full(s)


@router.patch("/{sheet_id}", response_model=SheetFull)
async def update_sheet(sheet_id: int, data: SheetUpdate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await db.get(Spreadsheet, sheet_id)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Sheet not found")
    if data.name is not None:
        s.name = data.name
    if data.data is not None:
        s.data = data.data
    await db.flush()
    await db.refresh(s)
    return _to_full(s)


@router.delete("/{sheet_id}")
async def delete_sheet(sheet_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await db.get(Spreadsheet, sheet_id)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Sheet not found")
    await db.delete(s)
    return {"ok": True}
