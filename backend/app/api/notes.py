from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

from app.db.session import get_db
from app.models.models import Note, User
from app.core.security import get_current_user

router = APIRouter(prefix="/api/notes", tags=["notes"])


class NoteOut(BaseModel):
    id: int
    title: Optional[str]
    body: str
    color: Optional[str]
    pinned: bool
    tags: Optional[str]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]

    class Config:
        from_attributes = True


class NoteIn(BaseModel):
    title: Optional[str] = None
    body: str = ""
    color: Optional[str] = None
    pinned: bool = False
    tags: Optional[str] = None


class NotePatch(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    tags: Optional[str] = None


@router.get("", response_model=list[NoteOut])
async def list_notes(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    q: Optional[str] = Query(None),
):
    query = select(Note).where(Note.owner_user_id == user.id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(or_(
            Note.title.ilike(like), Note.body.ilike(like), Note.tags.ilike(like),
        ))
    # Pinned first, then by updated/created desc
    query = query.order_by(Note.pinned.desc(), Note.updated_at.desc().nullslast(), Note.id.desc())
    return (await db.execute(query)).scalars().all()


@router.post("", response_model=NoteOut)
async def create_note(data: NoteIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    n = Note(owner_user_id=user.id, **data.model_dump())
    db.add(n)
    await db.flush()
    await db.refresh(n)
    return n


@router.patch("/{nid}", response_model=NoteOut)
async def update_note(nid: int, data: NotePatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    n = await db.get(Note, nid)
    if not n or n.owner_user_id != user.id:
        raise HTTPException(404, "Note not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(n, k, v)
    await db.flush()
    await db.refresh(n)
    return n


@router.delete("/{nid}")
async def delete_note(nid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    n = await db.get(Note, nid)
    if not n or n.owner_user_id != user.id:
        raise HTTPException(404, "Note not found")
    await db.delete(n)
    return {"ok": True}
