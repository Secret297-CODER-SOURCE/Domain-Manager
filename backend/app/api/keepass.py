from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.db.session import get_db
from app.models.models import KeepassVault, KeepassShare, User
from app.core.security import require_admin
from app.core.config import settings


def _fernet() -> Fernet:
    # Derive a stable 32-byte key from the platform SECRET_KEY.
    digest = hashlib.sha256(settings.SECRET_KEY.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(s: str) -> str:
    return _fernet().encrypt(s.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    return _fernet().decrypt(token.encode("ascii")).decode("utf-8")

# Admin-only — KeePass vaults are a sensitive admin feature.
router = APIRouter(prefix="/api/keepass", tags=["keepass"])

MAX_BLOB = 25 * 1024 * 1024  # 25 MB


class VaultOut(BaseModel):
    id: int
    name: str
    size_bytes: int
    owner_user_id: int
    owner_username: Optional[str] = None
    can_edit: bool = True
    is_owner: bool = True
    has_stored_master: bool = False  # only meaningful for owner
    shared_with: list[dict] = []
    updated_at: Optional[datetime]
    created_at: Optional[datetime]


class ShareIn(BaseModel):
    user_id: int
    can_edit: bool = False


async def _vault_access(db: AsyncSession, vault_id: int, user: User, need_edit: bool = False):
    v = await db.get(KeepassVault, vault_id)
    if not v:
        raise HTTPException(404, "Vault not found")
    if v.owner_user_id == user.id:
        return v, True, True
    share = (await db.execute(
        select(KeepassShare).where(KeepassShare.vault_id == vault_id, KeepassShare.user_id == user.id)
    )).scalar_one_or_none()
    if not share:
        raise HTTPException(403, "No access to this vault")
    if need_edit and not share.can_edit:
        raise HTTPException(403, "Read-only share")
    return v, False, share.can_edit


async def _vault_to_out(v: KeepassVault, db: AsyncSession, current_user: User) -> VaultOut:
    owner = await db.get(User, v.owner_user_id)
    shares_q = await db.execute(
        select(KeepassShare, User).join(User, KeepassShare.user_id == User.id).where(KeepassShare.vault_id == v.id)
    )
    shares = [
        {"user_id": s.user_id, "username": u.username, "can_edit": s.can_edit}
        for s, u in shares_q.all()
    ]
    is_owner = v.owner_user_id == current_user.id
    can_edit = is_owner
    if not is_owner:
        share = next((s for s in shares if s["user_id"] == current_user.id), None)
        can_edit = bool(share and share["can_edit"])
    return VaultOut(
        id=v.id, name=v.name, size_bytes=v.size_bytes,
        owner_user_id=v.owner_user_id, owner_username=owner.username if owner else None,
        is_owner=is_owner, can_edit=can_edit,
        has_stored_master=bool(v.owner_master_enc) if is_owner else False,
        shared_with=shares, updated_at=v.updated_at, created_at=v.created_at,
    )


@router.get("", response_model=list[VaultOut])
async def list_vaults(db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    # Owned vaults + vaults shared with me
    owned_q = await db.execute(select(KeepassVault).where(KeepassVault.owner_user_id == user.id))
    shared_q = await db.execute(
        select(KeepassVault).join(KeepassShare, KeepassShare.vault_id == KeepassVault.id)
        .where(KeepassShare.user_id == user.id)
    )
    vaults = list(owned_q.scalars().all()) + list(shared_q.scalars().all())
    # Dedupe by id, preserve order
    seen, out = set(), []
    for v in vaults:
        if v.id in seen:
            continue
        seen.add(v.id)
        out.append(await _vault_to_out(v, db, user))
    out.sort(key=lambda x: (x.updated_at or datetime.min), reverse=True)
    return out


@router.post("", response_model=VaultOut)
async def upload_vault(
    name: str = Form(...),
    file: UploadFile = File(...),
    remember_master: Optional[str] = Form(None),  # plain master password to store encrypted
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    blob = await file.read()
    if len(blob) > MAX_BLOB:
        raise HTTPException(413, f"File too large (>{MAX_BLOB // (1024*1024)} MB)")
    if not blob:
        raise HTTPException(400, "Empty file")
    v = KeepassVault(owner_user_id=user.id, name=name, blob=blob, size_bytes=len(blob))
    if remember_master:
        v.owner_master_enc = encrypt_secret(remember_master)
    db.add(v)
    await db.flush()
    await db.refresh(v)
    return await _vault_to_out(v, db, user)


@router.get("/{vault_id}/blob")
async def download_blob(vault_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v, _, _ = await _vault_access(db, vault_id, user)
    return Response(content=v.blob, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{v.name}.kdbx"'})


@router.put("/{vault_id}/blob", response_model=VaultOut)
async def update_blob(
    vault_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    v, _, _ = await _vault_access(db, vault_id, user, need_edit=True)
    blob = await file.read()
    if len(blob) > MAX_BLOB:
        raise HTTPException(413, "File too large")
    if not blob:
        raise HTTPException(400, "Empty file")
    v.blob = blob
    v.size_bytes = len(blob)
    await db.flush()
    await db.refresh(v)
    return await _vault_to_out(v, db, user)


class VaultPatch(BaseModel):
    name: str


@router.patch("/{vault_id}", response_model=VaultOut)
async def rename_vault(vault_id: int, data: VaultPatch, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v = await db.get(KeepassVault, vault_id)
    if not v or v.owner_user_id != user.id:
        raise HTTPException(404, "Vault not found")
    v.name = data.name
    await db.flush()
    await db.refresh(v)
    return await _vault_to_out(v, db, user)


@router.delete("/{vault_id}")
async def delete_vault(vault_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v = await db.get(KeepassVault, vault_id)
    if not v or v.owner_user_id != user.id:
        raise HTTPException(404, "Vault not found")
    await db.delete(v)
    return {"ok": True}


@router.post("/{vault_id}/shares", response_model=VaultOut)
async def add_share(vault_id: int, data: ShareIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v = await db.get(KeepassVault, vault_id)
    if not v or v.owner_user_id != user.id:
        raise HTTPException(404, "Vault not found")
    if data.user_id == user.id:
        raise HTTPException(400, "Cannot share with yourself")
    target = await db.get(User, data.user_id)
    if not target:
        raise HTTPException(404, "User not found")
    existing = (await db.execute(
        select(KeepassShare).where(KeepassShare.vault_id == vault_id, KeepassShare.user_id == data.user_id)
    )).scalar_one_or_none()
    if existing:
        existing.can_edit = data.can_edit
    else:
        db.add(KeepassShare(vault_id=vault_id, user_id=data.user_id, can_edit=data.can_edit))
    await db.flush()
    await db.refresh(v)
    return await _vault_to_out(v, db, user)


class MasterIn(BaseModel):
    password: str


@router.get("/{vault_id}/master")
async def get_stored_master(vault_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v = await db.get(KeepassVault, vault_id)
    if not v or v.owner_user_id != user.id:
        # Only owners can ever read their stored master pwd; sharees must use OOB.
        raise HTTPException(404, "Vault not found")
    if not v.owner_master_enc:
        raise HTTPException(404, "No stored master password")
    try:
        return {"password": decrypt_secret(v.owner_master_enc)}
    except InvalidToken:
        raise HTTPException(500, "Stored master is unreadable (SECRET_KEY changed?)")


@router.post("/{vault_id}/master", response_model=VaultOut)
async def set_stored_master(vault_id: int, data: MasterIn, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v = await db.get(KeepassVault, vault_id)
    if not v or v.owner_user_id != user.id:
        raise HTTPException(404, "Vault not found")
    if not data.password:
        raise HTTPException(400, "Password required")
    v.owner_master_enc = encrypt_secret(data.password)
    await db.flush()
    await db.refresh(v)
    return await _vault_to_out(v, db, user)


@router.delete("/{vault_id}/master", response_model=VaultOut)
async def clear_stored_master(vault_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v = await db.get(KeepassVault, vault_id)
    if not v or v.owner_user_id != user.id:
        raise HTTPException(404, "Vault not found")
    v.owner_master_enc = None
    await db.flush()
    await db.refresh(v)
    return await _vault_to_out(v, db, user)


@router.delete("/{vault_id}/shares/{user_id}")
async def remove_share(vault_id: int, user_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(require_admin)):
    v = await db.get(KeepassVault, vault_id)
    if not v or v.owner_user_id != user.id:
        raise HTTPException(404, "Vault not found")
    share = (await db.execute(
        select(KeepassShare).where(KeepassShare.vault_id == vault_id, KeepassShare.user_id == user_id)
    )).scalar_one_or_none()
    if share:
        await db.delete(share)
    return {"ok": True}
