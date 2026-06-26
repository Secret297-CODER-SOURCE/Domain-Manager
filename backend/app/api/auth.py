from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
import logging
from app.db.session import get_db
from app.models.models import User, UserRole, TelegramAdmin
from app.core.security import verify_password, hash_password, create_access_token, get_current_user, require_admin, require_delete_token
from app.core.config import settings
from app.services.audit import log_action

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

class Token(BaseModel):
    access_token: str
    token_type: str
    role: str
    username: str

class UserCreate(BaseModel):
    username: str
    password: str
    role: UserRole = UserRole.viewer

class UserOut(BaseModel):
    id: int
    username: str
    role: UserRole
    is_active: bool
    class Config:
        from_attributes = True

@router.post("/login", response_model=Token)
async def login(form_data: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.username == form_data.username))
    user = result.scalar_one_or_none()
    if not user or not verify_password(form_data.password, user.hashed_password):
        log_action(db, "login_failed", user=form_data.username,
                   details={"reason": "invalid_credentials"})
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not user.is_active:
        log_action(db, "login_failed", user=user.username, details={"reason": "user_disabled"})
        await db.commit()
        raise HTTPException(status_code=403, detail="User is disabled")
    token = create_access_token({"sub": user.username})
    log_action(db, "login_success", user=user, details={"role": user.role.value})
    await db.commit()
    return Token(access_token=token, token_type="bearer", role=user.role, username=user.username)

@router.post("/users", response_model=UserOut, dependencies=[Depends(require_admin)])
async def create_user(data: UserCreate, db: AsyncSession = Depends(get_db),
                       actor: User = Depends(get_current_user)):
    result = await db.execute(select(User).where(User.username == data.username))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already exists")
    user = User(username=data.username, hashed_password=hash_password(data.password), role=data.role)
    db.add(user)
    log_action(db, "user_create", user=actor, target=data.username,
               details={"role": data.role.value if hasattr(data.role, 'value') else str(data.role)})
    await db.flush()
    await db.refresh(user)
    return user

@router.get("/users", response_model=list[UserOut], dependencies=[Depends(require_admin)])
async def list_users(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).order_by(User.id))
    return result.scalars().all()

@router.delete("/users/{user_id}", dependencies=[Depends(require_delete_token)])
async def delete_user(user_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await db.delete(user)
    return {"ok": True}

@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    return current_user


class OtpVerifyRequest(BaseModel):
    code: str


@router.post("/delete-otp/request", dependencies=[Depends(require_admin)])
async def request_delete_otp(current_user: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    from app.services.delete_otp import generate_otp
    from app.services.telegram_bot import get_bot
    code = generate_otp(current_user.username)
    fmt = f"{code[:3]} {code[3:]}"
    text = (
        f"🔐 <b>Код підтвердження видалення</b>\n\n"
        f"👤 Користувач: <code>{current_user.username}</code>\n"
        f"🔑 Код: <b><code>{fmt}</code></b>\n\n"
        f"⏰ Дійсний 5 хвилин. Нікому не передавайте."
    )
    b = get_bot()
    if not b:
        return {"sent": False, "error": "Telegram не налаштовано"}

    # Send to all configured TG admins; fall back to TELEGRAM_CHAT_ID
    result = await db.execute(select(TelegramAdmin))
    tg_admins = result.scalars().all()
    chat_ids = [a.chat_id for a in tg_admins] if tg_admins else ([settings.TELEGRAM_CHAT_ID] if settings.TELEGRAM_CHAT_ID else [])

    if not chat_ids:
        return {"sent": False, "error": "Немає активованих Telegram отримувачів. Попросіть адміна написати боту /start"}

    sent_count = 0
    for chat_id in chat_ids:
        try:
            await b.send_message(chat_id=chat_id, text=text, parse_mode="HTML")
            sent_count += 1
        except Exception as e:
            logger.error(f"TG OTP send error to {chat_id}: {e}")

    return {"sent": sent_count > 0, "recipients": sent_count}


@router.post("/delete-otp/verify", dependencies=[Depends(require_admin)])
async def verify_delete_otp(body: OtpVerifyRequest, current_user: User = Depends(require_admin)):
    from app.services.delete_otp import verify_otp_and_issue_token
    token = verify_otp_and_issue_token(current_user.username, body.code)
    if not token:
        raise HTTPException(403, "Невірний або прострочений код")
    return {"delete_token": token, "expires_in": 300}


# ── Telegram admins ───────────────────────────────────────────────────────

class TGAdminCreate(BaseModel):
    chat_id: Optional[str] = None      # numeric TG user ID
    username: Optional[str] = None     # @username (without @)
    display_name: Optional[str] = None

class TGAdminOut(BaseModel):
    id: int
    chat_id: Optional[str]
    username: Optional[str]
    display_name: Optional[str]
    class Config:
        from_attributes = True


@router.get("/tg-admins", response_model=list[TGAdminOut], dependencies=[Depends(require_admin)])
async def list_tg_admins(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TelegramAdmin).order_by(TelegramAdmin.created_at))
    return result.scalars().all()


@router.post("/tg-admins", response_model=TGAdminOut, dependencies=[Depends(require_admin)])
async def add_tg_admin(data: TGAdminCreate, db: AsyncSession = Depends(get_db)):
    if not data.chat_id and not data.username:
        raise HTTPException(400, "Вкажіть chat_id або @username")

    clean_cid = data.chat_id.strip() if data.chat_id else None
    clean_un = data.username.strip().lstrip("@").lower() if data.username else None

    if clean_cid:
        ex = await db.execute(select(TelegramAdmin).where(TelegramAdmin.chat_id == clean_cid))
        if ex.scalar_one_or_none():
            raise HTTPException(400, "Цей chat_id вже додано")
    if clean_un:
        ex = await db.execute(select(TelegramAdmin).where(TelegramAdmin.username == clean_un))
        if ex.scalar_one_or_none():
            raise HTTPException(400, "Цей username вже додано")

    entry = TelegramAdmin(
        chat_id=clean_cid,
        username=clean_un,
        display_name=data.display_name.strip() if data.display_name else None,
    )
    db.add(entry)
    await db.flush()
    await db.refresh(entry)
    await db.commit()
    return entry


@router.delete("/tg-admins/{entry_id}", dependencies=[Depends(require_admin)])
async def delete_tg_admin(entry_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TelegramAdmin).where(TelegramAdmin.id == entry_id))
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(404, "Не знайдено")
    await db.delete(entry)
    await db.commit()
    return {"ok": True}
