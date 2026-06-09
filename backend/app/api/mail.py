from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional
import asyncio
import logging

from app.db.session import get_db
from app.models.models import MailAccount, User
from app.core.security import get_current_user
from app.core.crypto import encrypt_secret, decrypt_secret, InvalidToken
from app.services import imap_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mail", tags=["mail"])


# ── Presets ──────────────────────────────────────────────────────────────

PRESETS = {
    "gmail":    {"label": "Gmail",         "host": "imap.gmail.com",          "port": 993, "ssl": True,  "hint": "Потрібен App Password (Google → 2FA)"},
    "outlook":  {"label": "Outlook / Live","host": "outlook.office365.com",   "port": 993, "ssl": True,  "hint": "Microsoft може вимагати OAuth для нових акаунтів"},
    "yahoo":    {"label": "Yahoo",         "host": "imap.mail.yahoo.com",     "port": 993, "ssl": True,  "hint": "Згенеруйте App Password у налаштуваннях Yahoo"},
    "icloud":   {"label": "iCloud",        "host": "imap.mail.me.com",        "port": 993, "ssl": True,  "hint": "Згенеруйте App-Specific Password у appleid.apple.com"},
    "yandex":   {"label": "Yandex",        "host": "imap.yandex.com",         "port": 993, "ssl": True,  "hint": "Увімкніть IMAP в налаштуваннях пошти"},
    "mailru":   {"label": "Mail.ru",       "host": "imap.mail.ru",            "port": 993, "ssl": True,  "hint": "Згенеруйте Password for External Apps"},
    "zoho":     {"label": "Zoho",          "host": "imap.zoho.com",           "port": 993, "ssl": True,  "hint": ""},
    "fastmail": {"label": "FastMail",      "host": "imap.fastmail.com",       "port": 993, "ssl": True,  "hint": ""},
    "custom":   {"label": "Свій сервер",   "host": "",                        "port": 993, "ssl": True,  "hint": ""},
}


@router.get("/presets")
async def get_presets(_: User = Depends(get_current_user)):
    return PRESETS


# ── Schemas ──────────────────────────────────────────────────────────────

class AccountOut(BaseModel):
    id: int
    label: Optional[str]
    email: str
    imap_host: str
    imap_port: int
    imap_ssl: bool
    username: str
    color: Optional[str]
    last_check_at: Optional[datetime]
    last_unread: Optional[int]
    last_total: Optional[int]
    last_error: Optional[str]
    created_at: Optional[datetime]

    class Config:
        from_attributes = True


class AccountIn(BaseModel):
    label: Optional[str] = None
    email: str
    imap_host: str
    imap_port: int = 993
    imap_ssl: bool = True
    username: str
    password: str
    color: Optional[str] = None


class AccountPatch(BaseModel):
    label: Optional[str] = None
    email: Optional[str] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_ssl: Optional[bool] = None
    username: Optional[str] = None
    password: Optional[str] = None
    color: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────

async def _owned(db: AsyncSession, account_id: int, user: User) -> MailAccount:
    a = await db.get(MailAccount, account_id)
    if not a or a.owner_user_id != user.id:
        raise HTTPException(404, "Mail account not found")
    return a


def _decrypt_or_raise(a: MailAccount) -> str:
    try:
        return decrypt_secret(a.password_enc)
    except InvalidToken:
        raise HTTPException(500, "Stored password is unreadable (SECRET_KEY changed?)")


def _to_out(a: MailAccount) -> AccountOut:
    return AccountOut.model_validate(a)


# ── CRUD ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[AccountOut])
async def list_accounts(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(MailAccount).where(MailAccount.owner_user_id == user.id).order_by(MailAccount.id)
    return (await db.execute(q)).scalars().all()


@router.post("/test")
async def test_credentials(data: AccountIn, _: User = Depends(get_current_user)):
    """Validate IMAP credentials without saving."""
    try:
        r = await asyncio.to_thread(
            imap_client.check_account,
            data.imap_host, data.imap_port, data.imap_ssl, data.username, data.password,
        )
        return {"ok": True, **r}
    except Exception as e:
        raise HTTPException(400, f"IMAP error: {e}")


@router.post("", response_model=AccountOut)
async def create_account(data: AccountIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    # Validate credentials first
    try:
        r = await asyncio.to_thread(
            imap_client.check_account,
            data.imap_host, data.imap_port, data.imap_ssl, data.username, data.password,
        )
    except Exception as e:
        raise HTTPException(400, f"IMAP error: {e}")
    a = MailAccount(
        owner_user_id=user.id,
        label=data.label, email=data.email,
        imap_host=data.imap_host, imap_port=data.imap_port, imap_ssl=data.imap_ssl,
        username=data.username, password_enc=encrypt_secret(data.password),
        color=data.color,
        last_check_at=datetime.now(timezone.utc),
        last_unread=r.get("unread"), last_total=r.get("total"),
    )
    db.add(a)
    await db.flush()
    await db.refresh(a)
    return a


@router.patch("/{aid}", response_model=AccountOut)
async def update_account(aid: int, data: AccountPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    for k, v in data.model_dump(exclude_unset=True).items():
        if k == "password":
            if v: a.password_enc = encrypt_secret(v)
        else:
            setattr(a, k, v)
    await db.flush()
    await db.refresh(a)
    return a


@router.delete("/{aid}")
async def delete_account(aid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    await db.delete(a)
    return {"ok": True}


# ── Check unread / refresh ────────────────────────────────────────────────

@router.post("/{aid}/check", response_model=AccountOut)
async def refresh_unread(aid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    pw = _decrypt_or_raise(a)
    a.last_check_at = datetime.now(timezone.utc)
    try:
        r = await asyncio.to_thread(
            imap_client.check_account, a.imap_host, a.imap_port, a.imap_ssl, a.username, pw,
        )
        a.last_unread = r["unread"]; a.last_total = r["total"]; a.last_error = None
    except Exception as e:
        a.last_error = str(e)[:500]
    await db.flush()
    await db.refresh(a)
    return a


@router.post("/check-all")
async def refresh_all(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(MailAccount).where(MailAccount.owner_user_id == user.id)
    accounts = (await db.execute(q)).scalars().all()
    sem = asyncio.Semaphore(5)

    async def one(a: MailAccount):
        async with sem:
            a.last_check_at = datetime.now(timezone.utc)
            try:
                pw = decrypt_secret(a.password_enc)
                r = await asyncio.to_thread(
                    imap_client.check_account, a.imap_host, a.imap_port, a.imap_ssl, a.username, pw,
                )
                a.last_unread = r["unread"]; a.last_total = r["total"]; a.last_error = None
            except Exception as e:
                a.last_error = str(e)[:500]

    await asyncio.gather(*[one(a) for a in accounts])
    await db.flush()
    return {"ok": True, "checked": len(accounts)}


# ── Messages ─────────────────────────────────────────────────────────────

@router.get("/{aid}/messages")
async def list_messages(aid: int, limit: int = 50, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    pw = _decrypt_or_raise(a)
    try:
        msgs = await asyncio.to_thread(
            imap_client.list_messages, a.imap_host, a.imap_port, a.imap_ssl, a.username, pw, limit,
        )
        return {"messages": msgs}
    except Exception as e:
        raise HTTPException(502, f"IMAP error: {e}")


@router.get("/{aid}/messages/{uid}")
async def get_message(aid: int, uid: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    pw = _decrypt_or_raise(a)
    try:
        m = await asyncio.to_thread(
            imap_client.fetch_message, a.imap_host, a.imap_port, a.imap_ssl, a.username, pw, uid,
        )
        if not m:
            raise HTTPException(404, "Message not found")
        return m
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"IMAP error: {e}")
