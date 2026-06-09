from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

from app.db.session import get_db
from app.models.models import KumaInstance, User
from app.core.security import get_current_user

router = APIRouter(prefix="/api/kuma", tags=["kuma"])


class KumaOut(BaseModel):
    id: int
    name: str
    url: str
    color: Optional[str]
    sort_order: int
    notes: Optional[str]
    created_at: Optional[datetime]
    class Config:
        from_attributes = True


class KumaIn(BaseModel):
    name: str
    url: str
    color: Optional[str] = None
    sort_order: int = 0
    notes: Optional[str] = None


@router.get("", response_model=list[KumaOut])
async def list_kuma(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(KumaInstance).where(KumaInstance.owner_user_id == user.id).order_by(KumaInstance.sort_order, KumaInstance.id)
    return (await db.execute(q)).scalars().all()


@router.post("", response_model=KumaOut)
async def create(data: KumaIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    k = KumaInstance(owner_user_id=user.id, **data.model_dump())
    db.add(k)
    await db.flush()
    await db.refresh(k)
    return k


@router.patch("/{kid}", response_model=KumaOut)
async def update(kid: int, data: KumaIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    k = await db.get(KumaInstance, kid)
    if not k or k.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    for f, v in data.model_dump(exclude_unset=True).items():
        setattr(k, f, v)
    await db.flush()
    await db.refresh(k)
    return k


@router.delete("/{kid}")
async def delete(kid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    k = await db.get(KumaInstance, kid)
    if not k or k.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    await db.delete(k)
    return {"ok": True}
