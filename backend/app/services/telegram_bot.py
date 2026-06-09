import asyncio, logging
from datetime import datetime, timezone
from aiogram import Bot, Dispatcher, types, F
from sqlalchemy import select
from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import (
    Domain, CloudflareAccount, Team, AbuseAlert, DomainStatus,
    DnsRecord, TelegramAdmin,
)
from app.services.cloudflare.cf_zones import get_zone_status
from app.services.cloudflare.cf_dns import delete_record as cf_delete_record

logger = logging.getLogger(__name__)
bot: Bot = None
dp = Dispatcher()


def get_bot() -> Bot:
    global bot
    if bot is None and settings.TELEGRAM_BOT_TOKEN:
        bot = Bot(token=settings.TELEGRAM_BOT_TOKEN)
    return bot


async def get_active_chat_ids(db) -> list[str]:
    """Return chat_ids of all TG admins that have activated the bot."""
    result = await db.execute(
        select(TelegramAdmin).where(TelegramAdmin.chat_id.isnot(None))
    )
    return [a.chat_id for a in result.scalars().all()]


async def notify_admins(text: str):
    """Send a message to all active TG admins."""
    b = get_bot()
    if not b:
        return
    async with AsyncSessionLocal() as db:
        chat_ids = await get_active_chat_ids(db)
    for cid in chat_ids:
        try:
            await b.send_message(chat_id=cid, text=text, parse_mode="HTML")
        except Exception as e:
            logger.error(f"TG notify error to {cid}: {e}")


async def check_all_zones():
    if not settings.TELEGRAM_BOT_TOKEN:
        return
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Domain, CloudflareAccount, Team)
            .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
            .join(Team, CloudflareAccount.team_id == Team.id)
            .where(CloudflareAccount.is_active == True)
        )
        rows = result.all()
        for domain, account, team in rows:
            try:
                raw_status = await get_zone_status(
                    account.email, account.api_key, domain.zone_id
                )
                status_map = {
                    "active": DomainStatus.active,
                    "pending": DomainStatus.pending,
                    "paused": DomainStatus.suspended,
                }
                new_status = status_map.get(raw_status, DomainStatus.unknown)

                if new_status == DomainStatus.suspended and domain.zone_status != DomainStatus.suspended:
                    prev_status = domain.zone_status
                    domain.zone_status = new_status
                    domain.last_checked_at = datetime.now(timezone.utc)

                    # Auto-delete all DNS records immediately
                    deleted_count = 0
                    dns_result = await db.execute(select(DnsRecord).where(DnsRecord.domain_id == domain.id))
                    for rec in dns_result.scalars().all():
                        if rec.cf_record_id:
                            ok = await cf_delete_record(
                                account.email, account.api_key, domain.zone_id, rec.cf_record_id
                            )
                            if ok:
                                await db.delete(rec)
                                deleted_count += 1
                    domain.main_record_type = None
                    domain.main_record_value = None

                    # Record abuse alert as already resolved + dns_deleted
                    kt_group_name = domain.keitaro_group.name if domain.keitaro_group else "—"
                    alert = AbuseAlert(
                        domain_id=domain.id,
                        previous_status=prev_status,
                        new_status=new_status,
                        dns_deleted=True,
                        resolved=True,
                    )
                    db.add(alert)

                    # Notify all admins (info only, no buttons needed)
                    text = (
                        f"🚨 <b>ABUSE / SUSPENDED — DNS видалено</b>\n\n"
                        f"🌐 Домен: <code>{domain.name}</code>\n"
                        f"👥 Команда: <b>{team.name}</b>\n"
                        f"☁️ CF акаунт: <b>{account.name}</b>\n"
                        f"📁 Група KT: <b>{kt_group_name}</b>\n"
                        f"🗑 Видалено DNS записів: <b>{deleted_count}</b>"
                    )
                    asyncio.create_task(notify_admins(text))

                elif domain.zone_status != new_status:
                    domain.zone_status = new_status
                    domain.last_checked_at = datetime.now(timezone.utc)

                    if new_status == DomainStatus.active and domain.zone_status == DomainStatus.suspended:
                        # Domain recovered
                        alert = AbuseAlert(
                            domain_id=domain.id,
                            previous_status=DomainStatus.suspended,
                            new_status=new_status,
                        )
                        db.add(alert)

            except Exception as e:
                logger.error(f"Error checking zone {domain.name}: {e}")
        await db.commit()


# ── Bot command handlers ───────────────────────────────────────────────────

@dp.message(F.text.startswith("/start"))
async def handle_start(message: types.Message):
    username = message.from_user.username
    # Auto-activate pending admin by username
    if username:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(TelegramAdmin).where(
                    TelegramAdmin.username == username.lower(),
                    TelegramAdmin.chat_id.is_(None),
                )
            )
            pending = result.scalar_one_or_none()
            if pending:
                pending.chat_id = str(message.from_user.id)
                await db.commit()
                await message.reply(
                    f"✅ <b>Активовано!</b> Тепер ви будете отримувати сповіщення про абузи та OTP коди.",
                    parse_mode="HTML",
                )
                return

    await message.reply(
        f"👋 <b>DomainMgr Bot</b>\n\n"
        f"Надішліть список доменів (по одному на рядок) — отримаєте відповідь по кожному.",
        parse_mode="HTML",
    )


@dp.message(F.text.startswith("/myid"))
async def handle_myid(message: types.Message):
    uid = message.from_user.id
    username = message.from_user.username or "—"
    await message.reply(
        f"🆔 Ваш Telegram ID: <code>{uid}</code>\n"
        f"👤 Username: @{username}",
        parse_mode="HTML",
    )


async def _is_tg_admin(chat_id: int) -> bool:
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TelegramAdmin).where(TelegramAdmin.chat_id == str(chat_id))
        )
        return result.scalar_one_or_none() is not None


@dp.message()
async def handle_domain_lookup(message: types.Message):
    if not message.text:
        return

    # Auto-activate if username is in pending list
    username = message.from_user.username
    if username:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(TelegramAdmin).where(
                    TelegramAdmin.username == username.lower(),
                    TelegramAdmin.chat_id.is_(None),
                )
            )
            pending = result.scalar_one_or_none()
            if pending:
                pending.chat_id = str(message.from_user.id)
                await db.commit()

    # Parse domain names from the message
    raw = message.text.strip()
    candidates = []
    for line in raw.splitlines():
        for part in line.replace(",", " ").replace(";", " ").split():
            part = part.strip().lower().lstrip("http://").lstrip("https://").split("/")[0]
            if "." in part and len(part) > 3:
                candidates.append(part)

    if not candidates:
        await message.reply("Надішліть список доменів (по одному на рядок).")
        return

    is_admin = await _is_tg_admin(message.from_user.id)

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Domain, CloudflareAccount, Team)
            .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
            .outerjoin(Team, CloudflareAccount.team_id == Team.id)
            .where(Domain.name.in_(candidates))
        )
        found = {d.name: (d, a, t) for d, a, t in result.all()}

    STATUS_EMOJI = {
        "active": "✅", "suspended": "🚨", "pending": "⏳", "unknown": "❓"
    }

    lines = []
    for domain in candidates:
        if domain in found:
            if is_admin:
                d, a, t = found[domain]
                emoji = STATUS_EMOJI.get(str(d.zone_status), "❓")
                team_str = t.name if t else "?"
                lines.append(f"{emoji} <code>{domain}</code> — <b>{team_str}</b>")
            else:
                lines.append(f"✅ <code>{domain}</code> — є в системі")
        else:
            if is_admin:
                lines.append(f"❌ <code>{domain}</code> — немає в системі")
            else:
                lines.append(f"❌ <code>{domain}</code> — домен не знайдено")

    # Send in chunks of 30 to stay under TG message limit
    for i in range(0, len(lines), 30):
        await message.reply("\n".join(lines[i:i + 30]), parse_mode="HTML")


async def start_bot():
    b = get_bot()
    if b:
        asyncio.create_task(dp.start_polling(b))
