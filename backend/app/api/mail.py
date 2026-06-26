from fastapi import APIRouter, Depends, HTTPException, Body, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional
import asyncio
import logging
import re
import time
from urllib.parse import urlparse

from jose import jwt, JWTError
import httpx
import aiohttp

from app.db.session import AsyncSessionLocal
from app.core.config import settings
from app.services import iframe_proxy
from app.services.audit import log_action

from app.db.session import get_db
from app.models.models import MailAccount, User
from app.core.security import get_current_user
from app.core.crypto import encrypt_secret, decrypt_secret, InvalidToken
from app.services import imap_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mail", tags=["mail"])


# ── Presets ──────────────────────────────────────────────────────────────

PRESETS = {
    "gmail":    {"label": "Gmail",         "host": "imap.gmail.com",          "port": 993, "ssl": True,
                 "hint": "Звичайний пароль не приймається. Увімкніть 2FA → створіть App Password і вставте сюди.",
                 "app_password_url": "https://myaccount.google.com/apppasswords"},
    "outlook":  {"label": "Outlook / Live","host": "outlook.office365.com",   "port": 993, "ssl": True,
                 "hint": "Microsoft вимкнув basic auth у вересні 2024. Увімкніть «Двоетапну перевірку» на акаунті, потім згенеруйте App Password — і використовуйте ЙОГО, а не пароль від акаунту.",
                 "app_password_url": "https://account.live.com/proofs/AppPassword"},
    "yahoo":    {"label": "Yahoo",         "host": "imap.mail.yahoo.com",     "port": 993, "ssl": True,
                 "hint": "Yahoo не приймає основний пароль. Створіть App Password в налаштуваннях безпеки.",
                 "app_password_url": "https://login.yahoo.com/account/security/app-passwords"},
    "icloud":   {"label": "iCloud",        "host": "imap.mail.me.com",        "port": 993, "ssl": True,
                 "hint": "Згенеруйте App-Specific Password на appleid.apple.com → Sign-In and Security.",
                 "app_password_url": "https://appleid.apple.com/account/manage"},
    "yandex":   {"label": "Yandex",        "host": "imap.yandex.com",         "port": 993, "ssl": True,
                 "hint": "Увімкніть IMAP у налаштуваннях пошти. Якщо включене 2FA — створіть пароль додатка.",
                 "app_password_url": "https://id.yandex.com/security/app-passwords"},
    "mailru":   {"label": "Mail.ru",       "host": "imap.mail.ru",            "port": 993, "ssl": True,
                 "hint": "Згенеруйте «Пароль для зовнішніх додатків» у налаштуваннях акаунту.",
                 "app_password_url": "https://account.mail.ru/user/2-step-auth/passwords"},
    "zoho":     {"label": "Zoho",          "host": "imap.zoho.com",           "port": 993, "ssl": True,
                 "hint": "Якщо включене 2FA — створіть App Password у налаштуваннях.",
                 "app_password_url": "https://accounts.zoho.com/home#security/app_password"},
    "fastmail": {"label": "FastMail",      "host": "imap.fastmail.com",       "port": 993, "ssl": True,
                 "hint": "Створіть App Password у налаштуваннях.",
                 "app_password_url": "https://app.fastmail.com/settings/security/devicekeys"},
    "proton":   {"label": "ProtonMail (Bridge)", "host": "host.docker.internal", "port": 1143, "ssl": False, "hint": "Потрібен ProtonMail Bridge (платний Proton Plus+) запущений на macOS/Windows хості з вашим Proton акаунтом. Bridge видає окремий IMAP-пароль у налаштуваннях — НЕ ваш реальний пароль від ProtonMail. Bridge створює IMAP-сервер на 127.0.0.1:1143; з контейнера ми звертаємось через host.docker.internal."},
    # Tutanota (now "Tuta Mail") does NOT offer IMAP/SMTP at all by design.
    # Their web client at app.tuta.com uses end-to-end crypto via custom protocol.
    # We treat it as credential-only (same as Proton without Bridge): store creds,
    # open in popup window for actual use, no IMAP polling attempted.
    "tutanota": {"label": "Tuta Mail (Tutanota)", "host": "", "port": 0, "ssl": False, "hint": "Tuta (раніше Tutanota) не підтримує IMAP/SMTP — у них власний E2E протокол. Креди зберігаються у платформі, веб-пошта відкривається у окремому вікні app.tuta.com з нативною сесією."},
    "custom":   {"label": "Свій сервер",   "host": "",                        "port": 993, "ssl": True,  "hint": ""},
}


# Map email domain → preset key. Used to auto-detect IMAP server.
DOMAIN_TO_PRESET = {
    "gmail.com": "gmail", "googlemail.com": "gmail",
    "outlook.com": "outlook", "hotmail.com": "outlook", "live.com": "outlook",
    "msn.com": "outlook", "outlook.fr": "outlook", "outlook.de": "outlook",
    "yahoo.com": "yahoo", "yahoo.co.uk": "yahoo", "yahoo.fr": "yahoo",
    "yahoo.de": "yahoo", "ymail.com": "yahoo", "rocketmail.com": "yahoo",
    "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud",
    "yandex.com": "yandex", "yandex.ru": "yandex", "ya.ru": "yandex",
    "yandex.kz": "yandex", "yandex.by": "yandex", "yandex.ua": "yandex",
    "mail.ru": "mailru", "inbox.ru": "mailru", "bk.ru": "mailru",
    "list.ru": "mailru", "internet.ru": "mailru",
    "protonmail.com": "proton", "proton.me": "proton", "pm.me": "proton",
    "protonmail.ch": "proton",
    "tutanota.com": "tutanota", "tutanota.de": "tutanota", "tuta.io": "tutanota",
    "tuta.com": "tutanota", "keemail.me": "tutanota", "tutamail.com": "tutanota",
    "zoho.com": "zoho", "zohomail.com": "zoho",
    "fastmail.com": "fastmail", "fastmail.fm": "fastmail",
}


def humanize_imap_error(e: Exception, *, host: str = "", email: str = "") -> str:
    """Translate raw imaplib/SSL/socket errors into one actionable sentence.
    Strips the b'...' bytes repr that imaplib loves to leak."""
    raw = str(e)
    # imaplib serializes failures as b"text" — unwrap to readable form.
    m = re.search(r"^b['\"](.*)['\"]$", raw)
    if m:
        raw = m.group(1)
    raw = raw.replace("b'", "").replace("b\"", "").strip("'\" ")
    low = raw.lower()

    # Pick preset (by host or by email domain) so we can offer the app-password link.
    preset = None
    if host:
        for key, p in PRESETS.items():
            if p.get("host") and p["host"] == host:
                preset = (key, p); break
    if not preset and email:
        det = detect_preset(email)
        if det:
            preset = (det["key"], PRESETS[det["key"]])

    if "authenticate failed" in low or "auth" in low and "fail" in low or "login failed" in low \
       or "invalid credentials" in low or "logon failed" in low:
        if preset:
            key, p = preset
            tip = p.get("hint") or ""
            url = p.get("app_password_url")
            msg = f"Авторизація відхилена. {tip}"
            if url:
                msg += f" Створити App Password: {url}"
            return msg
        return "Авторизація відхилена. Перевірте логін/пароль; для більшості провайдерів потрібен App Password, а не звичайний пароль."

    if "ssl" in low and ("verify" in low or "certificate" in low):
        return f"SSL-помилка: {raw[:200]}"
    if "timed out" in low or "timeout" in low:
        return "Тайм-аут — IMAP-сервер не відповів. Перевірте host/port або мережу."
    if "name or service not known" in low or "getaddrinfo" in low or "nodename" in low:
        return f"DNS не знайшов хост «{host or '?'}». Перевірте IMAP host у налаштуваннях."
    if "connection refused" in low or "refused" in low:
        return "Зʼєднання відхилено — IMAP-порт закритий або вказано не той порт."
    if "no such host" in low:
        return f"Хост «{host}» не існує."
    return raw[:300] or e.__class__.__name__


def detect_preset(email: str) -> Optional[dict]:
    if "@" not in email:
        return None
    domain = email.rsplit("@", 1)[1].lower().strip()
    key = DOMAIN_TO_PRESET.get(domain)
    if not key:
        return None
    p = PRESETS[key]
    return {"key": key, "host": p["host"], "port": p["port"], "ssl": p["ssl"], "label": p["label"], "hint": p["hint"]}


@router.get("/presets")
async def get_presets(_: User = Depends(get_current_user)):
    return PRESETS


class DetectIn(BaseModel):
    email: str


@router.post("/detect")
async def detect_endpoint(data: DetectIn, _: User = Depends(get_current_user)):
    p = detect_preset(data.email)
    if not p:
        return {"detected": False}
    return {"detected": True, **p}


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
    tags: Optional[str] = None
    notes: Optional[str] = None
    linked_data: Optional[str] = None
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
    # Host/port/username are optional — backend auto-detects from email domain
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_ssl: Optional[bool] = None
    username: Optional[str] = None
    password: str
    color: Optional[str] = None


def _apply_autodetect(data: AccountIn) -> tuple[str, int, bool, str]:
    """Returns (host, port, ssl, username). Raises if can't detect for missing fields.
    For credential-only providers (Proton without Bridge, Tutanota) — allow empty host
    so they can be stored as vault entries without an IMAP target."""
    host = data.imap_host
    port = data.imap_port
    ssl = data.imap_ssl
    username = data.username or data.email

    email = (data.email or "").lower()
    is_cred_only = any(email.endswith(d) for d in CREDENTIAL_ONLY_DOMAINS)

    if not host or port is None or ssl is None:
        p = detect_preset(data.email)
        if not p:
            if is_cred_only:
                # Tutanota etc. — no IMAP exists; store with sentinel values
                return ("credential-only.local", 0, False, username)
            raise HTTPException(400, f"Не вдалось визначити IMAP сервер для {data.email}. Вкажіть host/port вручну.")
        host = host or p["host"] or "credential-only.local"
        port = port if port is not None else (p["port"] or 0)
        ssl = ssl if ssl is not None else p["ssl"]
    return host, port, ssl, username


class AccountPatch(BaseModel):
    label: Optional[str] = None
    email: Optional[str] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_ssl: Optional[bool] = None
    username: Optional[str] = None
    password: Optional[str] = None
    color: Optional[str] = None
    tags: Optional[str] = None
    notes: Optional[str] = None
    linked_data: Optional[str] = None


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


def _is_cred_only_host(host: str) -> bool:
    """True for sentinel hosts assigned to providers without IMAP (Tutanota etc.)."""
    return not host or host == "credential-only.local"


@router.post("/test")
async def test_credentials(data: AccountIn, _: User = Depends(get_current_user)):
    """Validate IMAP credentials without saving."""
    host, port, ssl, username = _apply_autodetect(data)
    if _is_cred_only_host(host):
        return {"ok": True, "host": host, "port": port, "ssl": ssl, "unread": None, "total": None,
                "note": "Це credential-only провайдер — IMAP не перевіряємо, креди збережуться як сховище."}
    try:
        r = await asyncio.to_thread(
            imap_client.check_account, host, port, ssl, username, data.password,
        )
        return {"ok": True, "host": host, "port": port, "ssl": ssl, **r}
    except Exception as e:
        raise HTTPException(400, humanize_imap_error(e, host=host, email=data.email))


@router.post("", response_model=AccountOut)
async def create_account(data: AccountIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    host, port, ssl, username = _apply_autodetect(data)
    # For credential-only providers (Tutanota, Proton without Bridge) skip IMAP check
    if _is_cred_only_host(host):
        a = MailAccount(
            owner_user_id=user.id,
            label=data.label or data.email.split("@")[0],
            email=data.email,
            imap_host=host or "credential-only.local",
            imap_port=port or 0, imap_ssl=False,
            username=username, password_enc=encrypt_secret(data.password),
            color=data.color, last_check_at=None,
            last_unread=None, last_total=None, last_error=None,
        )
        db.add(a)
        log_action(db, "mail_account_add", user=user, target=data.email,
                   details={"provider": host, "credential_only": True})
        await db.flush(); await db.refresh(a)
        return a

    # Validate credentials first for real IMAP providers
    try:
        r = await asyncio.to_thread(
            imap_client.check_account, host, port, ssl, username, data.password,
        )
    except Exception as e:
        raise HTTPException(400, humanize_imap_error(e, host=host, email=data.email))
    a = MailAccount(
        owner_user_id=user.id,
        label=data.label or data.email.split("@")[0],
        email=data.email,
        imap_host=host, imap_port=port, imap_ssl=ssl,
        username=username, password_enc=encrypt_secret(data.password),
        color=data.color,
        last_check_at=datetime.now(timezone.utc),
        last_unread=r.get("unread"), last_total=r.get("total"),
    )
    db.add(a)
    log_action(db, "mail_account_add", user=user, target=data.email,
               details={"provider": host, "port": port, "ssl": ssl})
    await db.flush()
    await db.refresh(a)
    return a


@router.patch("/{aid}", response_model=AccountOut)
async def update_account(aid: int, data: AccountPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    changes = {}
    for k, v in data.model_dump(exclude_unset=True).items():
        if k == "password":
            if v:
                a.password_enc = encrypt_secret(v)
                changes["password_rotated"] = True
        else:
            setattr(a, k, v)
            changes[k] = v
    log_action(db, "mail_account_update", user=user, target=a.email, details=changes)
    await db.flush()
    await db.refresh(a)
    try:
        from app.services.sheet_mirror import mirror_entity_to_sheets
        await mirror_entity_to_sheets(db, entity_kind="mail", owner_user_id=user.id)
    except Exception:
        pass
    return a


@router.delete("/{aid}")
async def delete_account(aid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    log_action(db, "mail_account_delete", user=user, target=a.email)
    await db.delete(a)
    return {"ok": True}


class BulkDeleteIn(BaseModel):
    ids: Optional[list[int]] = None
    all: bool = False


@router.post("/bulk-delete")
async def bulk_delete(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(MailAccount).where(MailAccount.owner_user_id == user.id)
    if not data.all and data.ids:
        q = q.where(MailAccount.id.in_(data.ids))
    rows = (await db.execute(q)).scalars().all()
    for r in rows:
        await db.delete(r)
    return {"deleted": len(rows)}


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
        a.last_error = humanize_imap_error(e, host=a.imap_host, email=a.email)[:500]
    await db.flush()
    await db.refresh(a)
    return a


CREDENTIAL_ONLY_DOMAINS = (
    "@protonmail.com", "@proton.me", "@pm.me", "@protonmail.ch",
    # Tutanota — no IMAP at all by design (E2E custom protocol)
    "@tutanota.com", "@tutanota.de", "@tuta.io", "@tuta.com",
    "@keemail.me", "@tutamail.com",
)


def _is_credential_only(email: str) -> bool:
    e = (email or "").lower()
    return any(e.endswith(d) for d in CREDENTIAL_ONLY_DOMAINS)


@router.post("/check-all")
async def refresh_all(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(MailAccount).where(MailAccount.owner_user_id == user.id)
    accounts = (await db.execute(q)).scalars().all()
    sem = asyncio.Semaphore(5)
    # Skip credential-only mailboxes (Proton) — they'd just produce noise
    candidates = [a for a in accounts if not _is_credential_only(a.email)]

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
                a.last_error = humanize_imap_error(e, host=a.imap_host, email=a.email)[:500]

    await asyncio.gather(*[one(a) for a in candidates])
    await db.flush()
    return {"ok": True, "checked": len(candidates), "skipped": len(accounts) - len(candidates)}


# ── Messages ─────────────────────────────────────────────────────────────

@router.get("/{aid}/credentials")
async def reveal_credentials(aid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Return stored email+password in plain. For accounts with no usable IMAP
    (e.g. ProtonMail without Bridge) — used by the UI as a credential vault view."""
    a = await _owned(db, aid, user)
    try:
        pw = decrypt_secret(a.password_enc)
    except InvalidToken:
        raise HTTPException(500, "Stored password is unreadable (SECRET_KEY changed?)")
    return {"email": a.email, "username": a.username, "password": pw}


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
        raise HTTPException(502, humanize_imap_error(e, host=a.imap_host, email=a.email))


# ── Import / Export ─────────────────────────────────────────────────────

# Matches "email:password" anywhere in a line.
# Email = standard; password = anything non-whitespace.
EMAIL_PWD_RE = re.compile(
    r'([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\s*:\s*(\S+)'
)


class ImportIn(BaseModel):
    text: str
    validate_each: bool = False
    skip_unknown_domains: bool = True


@router.post("/import")
async def import_accounts(
    data: ImportIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Parse free-form text for email:password pairs, add each as a mail account.
    Handles formatted text with banners, headers, decoration around the pairs."""
    pairs = []
    seen_in_input = set()
    for m in EMAIL_PWD_RE.finditer(data.text):
        email = m.group(1).strip().lower()
        password = m.group(2).strip()
        if email in seen_in_input:
            continue
        seen_in_input.add(email)
        pairs.append((email, password))

    if not pairs:
        return {"matched": 0, "created": 0, "skipped": 0, "errors": []}

    # Existing emails for dedup
    existing_q = await db.execute(select(MailAccount.email).where(MailAccount.owner_user_id == user.id))
    existing_emails = {row[0].lower() for row in existing_q.all()}

    created, skipped = 0, 0
    errors: list[dict] = []

    async def maybe_validate(host, port, ssl, username, password) -> tuple[Optional[int], Optional[int], Optional[str]]:
        if not data.validate_each:
            return None, None, None
        try:
            r = await asyncio.to_thread(imap_client.check_account, host, port, ssl, username, password)
            return r.get("unread"), r.get("total"), None
        except Exception as e:
            return None, None, str(e)[:300]

    for email, password in pairs:
        if email in existing_emails:
            skipped += 1
            continue
        preset = detect_preset(email)
        if not preset:
            if data.skip_unknown_domains:
                errors.append({"email": email, "error": "невідомий домен"})
                continue
            else:
                errors.append({"email": email, "error": "невідомий домен — пропущено"})
                continue
        username = email
        unread, total, err = await maybe_validate(preset["host"], preset["port"], preset["ssl"], username, password)
        if err:
            errors.append({"email": email, "error": err})
            continue
        a = MailAccount(
            owner_user_id=user.id,
            label=email.split("@")[0],
            email=email,
            imap_host=preset["host"],
            imap_port=preset["port"],
            imap_ssl=preset["ssl"],
            username=username,
            password_enc=encrypt_secret(password),
            last_check_at=datetime.now(timezone.utc) if data.validate_each else None,
            last_unread=unread, last_total=total,
        )
        db.add(a)
        existing_emails.add(email)
        created += 1

    await db.flush()
    return {
        "matched": len(pairs),
        "created": created,
        "skipped": skipped,
        "errors": errors,
    }


@router.get("/export")
async def export_accounts(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(MailAccount).where(MailAccount.owner_user_id == user.id).order_by(MailAccount.id)
    rows = (await db.execute(q)).scalars().all()
    lines = []
    for a in rows:
        try:
            pwd = decrypt_secret(a.password_enc)
        except Exception:
            continue
        lines.append(f"{a.email}:{pwd}")
    body = "\n".join(lines) + ("\n" if lines else "")
    return Response(
        content=body, media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="mail-accounts.txt"'},
    )


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
        raise HTTPException(502, humanize_imap_error(e, host=a.imap_host, email=a.email))


# ── Embedded webmail proxy ───────────────────────────────────────────────
# Lets the platform iframe each account's webmail (Proton/Gmail/Yandex/Mail.ru)
# at our own origin, stripping X-Frame-Options and rewriting absolute paths.
# Same auth model as Kuma: short-lived signed cookie scoped to the account path.

WEBMAIL_BASES = {
    "protonmail.com": "https://mail.proton.me",
    "proton.me":      "https://mail.proton.me",
    "pm.me":          "https://mail.proton.me",
    "protonmail.ch":  "https://mail.proton.me",
    # Tutanota (now Tuta Mail) — same web app for all their domains
    "tutanota.com":   "https://app.tuta.com",
    "tutanota.de":    "https://app.tuta.com",
    "tuta.io":        "https://app.tuta.com",
    "tuta.com":       "https://app.tuta.com",
    "keemail.me":     "https://app.tuta.com",
    "tutamail.com":   "https://app.tuta.com",
    "gmail.com":      "https://mail.google.com",
    "googlemail.com": "https://mail.google.com",
    "outlook.com":    "https://outlook.live.com",
    "hotmail.com":    "https://outlook.live.com",
    "live.com":       "https://outlook.live.com",
    "yahoo.com":      "https://mail.yahoo.com",
    "icloud.com":     "https://www.icloud.com",
    "me.com":         "https://www.icloud.com",
    "yandex.ru":      "https://mail.yandex.ru",
    "yandex.com":     "https://mail.yandex.com",
    "yandex.ua":      "https://mail.yandex.ua",
    "mail.ru":        "https://e.mail.ru",
    "inbox.ru":       "https://e.mail.ru",
}


def _webmail_base_for(email: str) -> Optional[str]:
    if not email or "@" not in email:
        return None
    domain = email.split("@", 1)[1].lower()
    return WEBMAIL_BASES.get(domain)


PROXY_COOKIE_PREFIX = "mail_proxy_"
PROXY_TTL_SECONDS = 3600


def _issue_proxy_token(username: str, aid: int) -> str:
    return jwt.encode(
        {"sub": username, "aid": aid, "purpose": "mail_proxy",
         "exp": int(time.time()) + PROXY_TTL_SECONDS},
        settings.SECRET_KEY, algorithm=settings.ALGORITHM,
    )


def _verify_proxy_token(token: str, aid: int) -> Optional[str]:
    try:
        p = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
    if p.get("purpose") != "mail_proxy" or p.get("aid") != aid:
        return None
    return p.get("sub")


class ProtonBulkConnectIn(BaseModel):
    proxy_id: Optional[int] = None
    only_unconnected: bool = True  # skip already-hydroxide-wired accounts


@router.post("/proton-bulk-connect")
async def proton_bulk_connect(
    data: ProtonBulkConnectIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Iterate all of the user's Proton accounts and try hydroxide auth for each
    with stored credentials. Returns per-account status (ok / captcha / 2fa / etc)."""
    q = select(MailAccount).where(MailAccount.owner_user_id == user.id)
    accounts = (await db.execute(q)).scalars().all()
    # Only ProtonMail family — exclude Tutanota and other credential-only domains
    PROTON_DOMAINS = ("@protonmail.com", "@proton.me", "@pm.me", "@protonmail.ch")
    proton_accs = [a for a in accounts if any(a.email.lower().endswith(d) for d in PROTON_DOMAINS)]
    if data.only_unconnected:
        proton_accs = [a for a in proton_accs if "hydroxide" not in (a.imap_host or "")]

    # Resolve proxy once for the whole batch
    proxy_url = None
    if data.proxy_id:
        from app.models.models import Proxy as ProxyModel
        from urllib.parse import quote as _q
        p = await db.get(ProxyModel, data.proxy_id)
        if not p or p.owner_user_id != user.id:
            raise HTTPException(404, "Proxy not found")
        auth = ""
        if p.username:
            auth = _q(p.username, safe="") + (":" + _q(p.password or "", safe="") if p.password else "") + "@"
        scheme = "socks5" if p.type == "socks5" else "http"
        proxy_url = f"{scheme}://{auth}{p.host}:{p.port}"

    results = []
    for a in proton_accs:
        try:
            pwd = decrypt_secret(a.password_enc)
        except Exception:
            results.append({"id": a.id, "email": a.email, "status": "error", "detail": "decrypt failed"})
            continue
        # Inline hydroxide call with shorter timeout to keep batch reasonable.
        try:
            exit_status, out = await asyncio.wait_for(
                asyncio.to_thread(_hydroxide_auth_pty_batch, a.email, pwd, None, proxy_url, 40),
                timeout=45,
            )
        except (asyncio.TimeoutError, TimeoutError):
            results.append({"id": a.id, "email": a.email, "status": "timeout"})
            continue
        combined = out.lower()
        if exit_status == 0:
            # Find bridge password and update account
            bridge_pwd = None
            for line in out.splitlines():
                s = line.strip()
                if s.lower().startswith("bridge password"):
                    bridge_pwd = s.split(":", 1)[1].strip(); break
                if re.fullmatch(r"[A-Za-z0-9_\-=]{16,}", s):
                    bridge_pwd = s; break
            if not bridge_pwd:
                results.append({"id": a.id, "email": a.email, "status": "error", "detail": "no bridge pwd in output"})
                continue
            a.imap_host = HYDROXIDE_HOST
            a.imap_port = HYDROXIDE_IMAP_PORT
            a.imap_ssl = False
            a.username = a.email
            a.password_enc = encrypt_secret(bridge_pwd)
            a.last_error = None
            await db.flush()
            results.append({"id": a.id, "email": a.email, "status": "ok"})
        else:
            status = "captcha" if ("captcha" in combined or "9001" in combined) else \
                     "2fa" if any(k in combined for k in ("two-factor", "2fa", "totp")) else \
                     "wrong_password" if any(k in combined for k in ("incorrect", "wrong password", "invalid")) else \
                     "not_found" if any(k in combined for k in ("8002", "does not exist", "not exist")) else "error"
            results.append({"id": a.id, "email": a.email, "status": status,
                            "detail": "\n".join(out.splitlines()[-3:])[:200]})

    ok = sum(1 for r in results if r["status"] == "ok")
    return {"total": len(results), "ok": ok, "results": results}


def _hydroxide_auth_pty_batch(email: str, password: str, totp: Optional[str], proxy: Optional[str], timeout: float) -> tuple[int, str]:
    """Standalone PTY-based hydroxide auth used by bulk endpoint. Mirrors the
    closure inside proton_connect but is a module-level function so we can call
    it via asyncio.to_thread cleanly."""
    import os, pty, select, errno, signal, time as _t
    env = {"XDG_CONFIG_HOME": "/data", "HOME": "/data",
           "PATH": "/usr/local/bin:/usr/bin:/bin", "TERM": "dumb"}
    if proxy:
        env["HTTPS_PROXY"] = proxy
        env["HTTP_PROXY"] = proxy
        env["NO_PROXY"] = "localhost,127.0.0.1"
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("hydroxide", [
            "hydroxide", "-app-version", "web-mail@5.0.999.999-dev",
            "auth", email,
        ], env)
    output = b""
    sent_password = False; sent_totp = False
    deadline = _t.monotonic() + timeout
    exit_status = None
    try:
        while True:
            if _t.monotonic() > deadline:
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
                try: os.waitpid(pid, 0)
                except ChildProcessError: pass
                raise TimeoutError()
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid != 0:
                    exit_status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
            except ChildProcessError:
                exit_status = 1
            rlist, _, _ = select.select([fd], [], [], 0.5)
            if fd in rlist:
                try:
                    chunk = os.read(fd, 4096)
                    if not chunk: break
                    output += chunk
                    lower = output.decode(errors="replace").lower()
                    if not sent_password and "password" in lower:
                        os.write(fd, (password + "\n").encode()); sent_password = True
                    if totp and not sent_totp and re.search(r"2fa|totp|code", lower):
                        os.write(fd, (totp + "\n").encode()); sent_totp = True
                except OSError as e:
                    if e.errno == errno.EIO: break
                    raise
            if exit_status is not None and not rlist:
                break
    finally:
        try: os.close(fd)
        except OSError: pass
        if exit_status is None:
            try:
                _, status = os.waitpid(pid, 0)
                exit_status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
            except ChildProcessError:
                exit_status = 1
    return exit_status, output.decode(errors="replace")


# ── Hydroxide-based ProtonMail integration ─────────────────────────────────
# Hydroxide is an open-source ProtonMail bridge (https://github.com/emersion/hydroxide).
# It speaks Proton's E2E-encrypted API and exposes plain IMAP/SMTP locally.
# We share /data volume with the hydroxide container; the auth files we write
# here become visible to the IMAP server.

HYDROXIDE_HOST = "dm_hydroxide"
HYDROXIDE_IMAP_PORT = 1143


class ProtonConnectIn(BaseModel):
    email: str
    password: str
    totp: Optional[str] = None  # 2FA code if account has it
    proxy_id: Optional[int] = None  # route hydroxide through one of the user's proxies


@router.post("/proton-connect")
async def proton_connect(
    data: ProtonConnectIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """One-time setup: authenticate a Proton account through hydroxide and store
    the bridge IMAP password (different from the user's Proton password)."""
    email = data.email.strip().lower()
    # CREDENTIAL_ONLY_DOMAINS entries already include the "@" prefix
    if not any(email.endswith(d) for d in CREDENTIAL_ONLY_DOMAINS):
        raise HTTPException(400, f"{email} не виглядає як ProtonMail")

    # Optional outbound proxy — bypasses Proton's CAPTCHA for known-good IPs.
    proxy_url = None
    if data.proxy_id:
        from app.models.models import Proxy as ProxyModel
        from urllib.parse import quote
        p = await db.get(ProxyModel, data.proxy_id)
        if not p or p.owner_user_id != user.id:
            raise HTTPException(404, "Proxy not found")
        auth = ""
        if p.username:
            auth = quote(p.username, safe="") + (":" + quote(p.password or "", safe="") if p.password else "") + "@"
        scheme = "socks5" if p.type == "socks5" else "http"
        proxy_url = f"{scheme}://{auth}{p.host}:{p.port}"

    # Hydroxide reads passwords directly from /dev/tty, not stdin — so we have to
    # spawn it through a PTY and feed prompts via the master fd.
    def _hydroxide_auth_pty(email: str, password: str, totp: Optional[str], proxy: Optional[str] = None, timeout: float = 60) -> tuple[int, str]:
        import os, pty, select, errno, signal, time as _t
        env = {
            "XDG_CONFIG_HOME": "/data", "HOME": "/data",
            "PATH": "/usr/local/bin:/usr/bin:/bin", "TERM": "dumb",
        }
        if proxy:
            # Go's net/http (which hydroxide uses) respects these env vars.
            env["HTTPS_PROXY"] = proxy
            env["HTTP_PROXY"] = proxy
            env["NO_PROXY"] = "localhost,127.0.0.1"
        pid, fd = pty.fork()
        if pid == 0:
            # child — exec hydroxide. `-app-version` mimics the web client so
            # Proton's anti-bot stops slapping CAPTCHA on every request.
            os.execvpe("hydroxide", [
                "hydroxide", "-app-version", "web-mail@5.0.999.999-dev",
                "auth", email,
            ], env)
        # parent
        output = b""
        sent_password = False
        sent_totp = False
        deadline = _t.monotonic() + timeout
        exit_status = None
        try:
            while True:
                if _t.monotonic() > deadline:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    try: os.waitpid(pid, 0)
                    except ChildProcessError: pass
                    raise TimeoutError("hydroxide auth timed out")
                # Reap child if exited
                try:
                    wpid, status = os.waitpid(pid, os.WNOHANG)
                    if wpid != 0:
                        exit_status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
                except ChildProcessError:
                    exit_status = 1
                # Read available output
                rlist, _, _ = select.select([fd], [], [], 0.5)
                if fd in rlist:
                    try:
                        chunk = os.read(fd, 4096)
                        if not chunk:
                            break
                        output += chunk
                        lower = output.decode(errors="replace").lower()
                        # Hydroxide prompts: "Password:" then optionally "2FA code:"
                        if not sent_password and "password" in lower:
                            os.write(fd, (password + "\n").encode())
                            sent_password = True
                        if totp and not sent_totp and re.search(r"2fa|totp|code", lower):
                            os.write(fd, (totp + "\n").encode())
                            sent_totp = True
                    except OSError as e:
                        if e.errno == errno.EIO:  # child closed pty
                            break
                        raise
                if exit_status is not None and not rlist:
                    break
        finally:
            try: os.close(fd)
            except OSError: pass
            if exit_status is None:
                try:
                    _, status = os.waitpid(pid, 0)
                    exit_status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
                except ChildProcessError:
                    exit_status = 1
        return exit_status, output.decode(errors="replace")

    try:
        exit_status, combined_out = await asyncio.wait_for(
            asyncio.to_thread(_hydroxide_auth_pty, email, data.password, data.totp, proxy_url, 90),
            timeout=100,
        )
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(504, "hydroxide auth timed out — перевірте мережу/проксі або 2FA")

    out = combined_out
    combined = combined_out.lower()

    if exit_status != 0:
        if "two-factor" in combined or "2fa" in combined or "totp" in combined:
            raise HTTPException(400, "Потрібен 2FA код")
        if "incorrect" in combined or "wrong password" in combined or "invalid" in combined:
            raise HTTPException(400, "Невірний пароль Proton")
        if "captcha" in combined or "9001" in combined:
            if proxy_url:
                raise HTTPException(
                    403,
                    "Proton все ще вимагає CAPTCHA навіть через цей проксі. "
                    "Спробуйте інший (residential/mobile) — datacenter IP'и здебільшого заблоковані.",
                )
            raise HTTPException(
                403,
                "Proton вимагає CAPTCHA для цього акаунту з вашого IP. "
                "Варіанти: (1) підключіть через проксі — оберіть зі списку у формі знизу; "
                "(2) увійдіть один раз у mail.proton.me з цієї машини (пройдіть капчу), "
                "потім спробуйте знову протягом години.",
            )
        if any(s in combined for s in ("10013", "8002", "does not exist", "not exist")):
            raise HTTPException(400, "Такого Proton акаунту не існує")
        # Show only relevant tail of hydroxide output
        snippet = "\n".join([l for l in out.splitlines() if l.strip()][-5:])[:400] or "невідома помилка"
        raise HTTPException(502, f"hydroxide: {snippet}")

    # The bridge password appears in stdout. hydroxide >= 0.2.x prints:
    #   "Bridge password: XXXX-XXXX-XXXX-XXXX"
    bridge_pwd = None
    for line in out.splitlines():
        s = line.strip()
        if s.lower().startswith("bridge password"):
            bridge_pwd = s.split(":", 1)[1].strip()
            break
        # Some versions just print the password on a single line
        if re.fullmatch(r"[A-Za-z0-9_\-=]{16,}", s):
            bridge_pwd = s
            break
    if not bridge_pwd:
        raise HTTPException(502, f"Не знайшов bridge password у виводі hydroxide:\n{out[:300]}")

    # hydroxide serve caches auth in memory at startup. After we add/update an
    # account we need to signal a reload. There is no SIGHUP — easiest is to
    # let hydroxide do lazy re-read on IMAP LOGIN failure, but that means the
    # first LOGIN attempt fails. Workaround: try a couple of times with backoff.

    # Upsert MailAccount: find existing by email or create new
    q = select(MailAccount).where(
        MailAccount.owner_user_id == user.id,
        MailAccount.email == email,
    )
    a = (await db.execute(q)).scalar_one_or_none()
    if a:
        a.imap_host = HYDROXIDE_HOST
        a.imap_port = HYDROXIDE_IMAP_PORT
        a.imap_ssl = False
        a.username = email
        a.password_enc = encrypt_secret(bridge_pwd)
        a.last_error = None
    else:
        a = MailAccount(
            owner_user_id=user.id,
            label=email.split("@")[0],
            email=email,
            imap_host=HYDROXIDE_HOST,
            imap_port=HYDROXIDE_IMAP_PORT,
            imap_ssl=False,
            username=email,
            password_enc=encrypt_secret(bridge_pwd),
        )
        db.add(a)
    await db.flush()
    await db.refresh(a)

    # Try IMAP check with retries — hydroxide serve may need a moment to notice
    # the new auth.json. Up to 5 attempts with 1s backoff.
    last_err = None
    for attempt in range(5):
        try:
            r = await asyncio.to_thread(
                imap_client.check_account, HYDROXIDE_HOST, HYDROXIDE_IMAP_PORT, False, email, bridge_pwd,
            )
            a.last_check_at = datetime.now(timezone.utc)
            a.last_unread = r.get("unread")
            a.last_total = r.get("total")
            a.last_error = None
            last_err = None
            break
        except Exception as e:
            last_err = str(e)[:300]
            await asyncio.sleep(1.0)
    if last_err:
        a.last_error = last_err

    await db.flush()
    return {"ok": True, "id": a.id, "imap_host": HYDROXIDE_HOST, "imap_port": HYDROXIDE_IMAP_PORT,
            "unread": a.last_unread, "total": a.last_total, "error": a.last_error}


@router.post("/{aid}/web-proxy-grant")
async def grant_web_proxy(aid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    a = await _owned(db, aid, user)
    base = _webmail_base_for(a.email)
    if not base:
        raise HTTPException(400, f"Невідомий вебпошт-провайдер для {a.email}")
    token = _issue_proxy_token(user.username, aid)
    resp = JSONResponse({"ok": True, "expires_in": PROXY_TTL_SECONDS, "base": base})
    resp.set_cookie(
        key=f"{PROXY_COOKIE_PREFIX}{aid}",
        value=token,
        max_age=PROXY_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        path=f"/api/mail/{aid}/",
    )
    return resp


@router.api_route(
    "/{aid}/web-proxy/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def web_proxy(aid: int, path: str, request: Request, db: AsyncSession = Depends(get_db)):
    cookie = request.cookies.get(f"{PROXY_COOKIE_PREFIX}{aid}")
    if not cookie:
        raise HTTPException(401, "Proxy not granted")
    username = _verify_proxy_token(cookie, aid)
    if not username:
        raise HTTPException(401, "Proxy token invalid")

    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not user:
            raise HTTPException(401, "User not found")
        a = await s.get(MailAccount, aid)
        if not a or a.owner_user_id != user.id:
            raise HTTPException(404, "Not found")
        base = _webmail_base_for(a.email)
        if not base:
            raise HTTPException(400, "Unknown provider")

    p = urlparse(base)
    origin = f"{p.scheme}://{p.netloc}"
    target = f"{origin}/{path}" if path else f"{origin}/"
    if request.url.query:
        target += "?" + request.url.query

    fwd_headers = {h: v for h, v in request.headers.items() if h.lower() not in iframe_proxy.DROP_REQ_HEADERS}
    fwd_headers["Host"] = p.netloc

    body_bytes = await request.body() if request.method not in ("GET", "HEAD") else None

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as c:
            upstream = await c.request(request.method, target, content=body_bytes, headers=fwd_headers)
    except Exception as e:
        return Response(content=f"Proxy error: {e}", status_code=502, media_type="text/plain")

    prefix = f"/api/mail/{aid}/web-proxy"
    ws_prefix = f"/api/mail/{aid}/web-proxy-ws"

    out_headers = {}
    for hn, hv in upstream.headers.items():
        if hn.lower() in iframe_proxy.DROP_RESP_HEADERS:
            continue
        if hn.lower() == "location":
            hv = iframe_proxy.rewrite_redirect_location(hv, prefix)
        out_headers[hn] = hv

    content = upstream.content
    ctype = upstream.headers.get("content-type", "").lower()
    if "text/html" in ctype and content:
        content = iframe_proxy.inject_runtime_patches(content, prefix, ws_prefix)
    elif "text/css" in ctype and content:
        content = iframe_proxy.rewrite_css(content, prefix)

    return Response(content=content, status_code=upstream.status_code, headers=out_headers, media_type=ctype or None)


@router.websocket("/{aid}/web-proxy-ws/{path:path}")
async def web_proxy_ws(websocket: WebSocket, aid: int, path: str):
    cookie = websocket.cookies.get(f"{PROXY_COOKIE_PREFIX}{aid}")
    if not cookie:
        await websocket.close(code=1008); return
    username = _verify_proxy_token(cookie, aid)
    if not username:
        await websocket.close(code=1008); return

    async with AsyncSessionLocal() as s:
        user = (await s.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not user:
            await websocket.close(code=1008); return
        a = await s.get(MailAccount, aid)
        if not a or a.owner_user_id != user.id:
            await websocket.close(code=1008); return
        base = _webmail_base_for(a.email)
        if not base:
            await websocket.close(code=1008); return

    p = urlparse(base)
    scheme = "wss" if p.scheme == "https" else "ws"
    qs = str(websocket.url.query)
    upstream_url = f"{scheme}://{p.netloc}/{path}"
    if qs:
        upstream_url += "?" + qs

    proto = (websocket.headers.get("sec-websocket-protocol", "") or "").split(",")[0].strip() or None
    await websocket.accept(subprotocol=proto)

    try:
        session = aiohttp.ClientSession()
        try:
            async with session.ws_connect(
                upstream_url, heartbeat=25, max_msg_size=0,
                headers={"User-Agent": "DomainManager-Mail-Proxy/1.0"},
            ) as upstream:
                async def c2u():
                    try:
                        while True:
                            msg = await websocket.receive()
                            if msg.get("type") == "websocket.disconnect":
                                break
                            if msg.get("text") is not None:
                                await upstream.send_str(msg["text"])
                            elif msg.get("bytes") is not None:
                                await upstream.send_bytes(msg["bytes"])
                    except WebSocketDisconnect:
                        pass
                    except Exception as e:
                        logger.debug(f"[mail-ws] c→u closed: {e}")
                    finally:
                        try: await upstream.close()
                        except Exception: pass

                async def u2c():
                    try:
                        async for msg in upstream:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await websocket.send_text(msg.data)
                            elif msg.type == aiohttp.WSMsgType.BINARY:
                                await websocket.send_bytes(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                break
                    except Exception as e:
                        logger.debug(f"[mail-ws] u→c closed: {e}")
                    finally:
                        try: await websocket.close()
                        except Exception: pass

                t1 = asyncio.create_task(c2u())
                t2 = asyncio.create_task(u2c())
                done, pending = await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                    try: await t
                    except Exception: pass
        finally:
            await session.close()
    except aiohttp.ClientError as e:
        logger.warning(f"[mail-ws] upstream connect failed: {e}")
        try: await websocket.close(code=1011)
        except Exception: pass
    except Exception as e:
        logger.exception(f"[mail-ws] unexpected: {e}")
        try: await websocket.close(code=1011)
        except Exception: pass
