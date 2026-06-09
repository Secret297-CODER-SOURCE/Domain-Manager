from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

from app.db.session import get_db
from app.models.models import Purchase, User
from app.core.security import get_current_user

router = APIRouter(prefix="/api/purchases", tags=["purchases"])


class PurchaseOut(BaseModel):
    id: int
    category: str
    label: str
    provider: Optional[str]
    login: Optional[str]
    password: Optional[str]
    url: Optional[str]
    cost_amount: Optional[str]
    cost_currency: Optional[str]
    purchased_at: Optional[datetime]
    expires_at: Optional[datetime]
    status: str
    tags: Optional[str]
    notes: Optional[str]
    created_at: Optional[datetime]
    class Config:
        from_attributes = True


class PurchaseIn(BaseModel):
    category: str = "account"
    label: str
    provider: Optional[str] = None
    login: Optional[str] = None
    password: Optional[str] = None
    url: Optional[str] = None
    cost_amount: Optional[str] = None
    cost_currency: Optional[str] = "USD"
    purchased_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    status: str = "active"
    tags: Optional[str] = None
    notes: Optional[str] = None


@router.get("", response_model=list[PurchaseOut])
async def list_purchases(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Purchase).where(Purchase.owner_user_id == user.id).order_by(Purchase.id.desc())
    return (await db.execute(q)).scalars().all()


@router.post("", response_model=PurchaseOut)
async def create(data: PurchaseIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    p = Purchase(owner_user_id=user.id, **data.model_dump())
    db.add(p)
    await db.flush()
    await db.refresh(p)
    return p


@router.patch("/{pid}", response_model=PurchaseOut)
async def update(pid: int, data: PurchaseIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    p = await db.get(Purchase, pid)
    if not p or p.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    await db.flush()
    await db.refresh(p)
    return p


@router.delete("/{pid}")
async def delete(pid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    p = await db.get(Purchase, pid)
    if not p or p.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    await db.delete(p)
    return {"ok": True}


@router.get("/stats")
async def stats(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Purchase.category, Purchase.status, func.count(Purchase.id)).where(
        Purchase.owner_user_id == user.id
    ).group_by(Purchase.category, Purchase.status)
    rows = (await db.execute(q)).all()
    out: dict = {}
    for cat, st, n in rows:
        out.setdefault(cat, {})[st] = n
    return out
