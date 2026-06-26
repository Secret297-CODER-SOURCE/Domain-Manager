import asyncio, logging
from datetime import datetime, timezone
from aiogram import Bot, Dispatcher, types, F
from sqlalchemy import select
from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import (
    Domain, CloudflareAccount, Team, AbuseAlert, DomainStatus,
    DnsRecord, TelegramAdmin, BackupConfig,
)
from app.services.cloudflare.cf_zones import get_zone_status
from app.services.cloudflare.cf_dns import delete_record as cf_delete_record

logger = logging.getLogger(__name__)
bot: Bot = None
dp = Dispatcher()

PLATFORM_URL = "https://domain-manage.tech/"
PLATFORM_FOOTER = f'\n\n— <a href="{PLATFORM_URL}">domain-manage.tech</a>'


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
    body = text + PLATFORM_FOOTER
    async with AsyncSessionLocal() as db:
        chat_ids = await get_active_chat_ids(db)
    for cid in chat_ids:
        try:
            await b.send_message(chat_id=cid, text=body, parse_mode="HTML",
                                  disable_web_page_preview=True)
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
                        f"<b>[ABUSE / SUSPENDED — DNS видалено]</b>\n\n"
                        f"Домен: <code>{domain.name}</code>\n"
                        f"Команда: <b>{team.name}</b>\n"
                        f"CF акаунт: <b>{account.name}</b>\n"
                        f"Група KT: <b>{kt_group_name}</b>\n"
                        f"Видалено DNS записів: <b>{deleted_count}</b>"
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
@dp.edited_message(F.text.startswith("/start"))
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
                    "<b>[OK] Активовано!</b> Тепер ви будете отримувати сповіщення про абузи та OTP коди."
                    + PLATFORM_FOOTER,
                    parse_mode="HTML", disable_web_page_preview=True,
                )
                return

    await message.reply(
        "<b>DomainMgr Bot</b>\n\n"
        "Надішліть список доменів (по одному на рядок) — відповім, чи це наш домен.\n\n"
        "<b>Front-end режим</b>:\n"
        "<code>/fe &lt;кодове слово&gt; домен1 домен2</code>\n"
        "Покаже статус і назву команди, якщо кодове слово вірне."
        + PLATFORM_FOOTER,
        parse_mode="HTML", disable_web_page_preview=True,
    )


@dp.message(F.text.startswith("/myid"))
@dp.edited_message(F.text.startswith("/myid"))
async def handle_myid(message: types.Message):
    uid = message.from_user.id
    username = message.from_user.username or "—"
    await message.reply(
        f"Ваш Telegram ID: <code>{uid}</code>\n"
        f"Username: @{username}"
        + PLATFORM_FOOTER,
        parse_mode="HTML", disable_web_page_preview=True,
    )


async def _is_tg_admin(chat_id: int) -> bool:
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TelegramAdmin).where(TelegramAdmin.chat_id == str(chat_id))
        )
        return result.scalar_one_or_none() is not None


def _parse_domains(text: str) -> list[str]:
    """Pull domain-like tokens out of arbitrary text. Strips scheme/path/leading
    `www.` and lowercases. Keeps tokens with a `.` and length > 3."""
    out = []
    for line in text.splitlines():
        for part in line.replace(",", " ").replace(";", " ").split():
            t = part.strip().lower()
            for pref in ("http://", "https://"):
                if t.startswith(pref):
                    t = t[len(pref):]
            t = t.split("/", 1)[0]
            if t.startswith("www."):
                t = t[4:]
            if "." in t and len(t) > 3:
                out.append(t)
    return out


STATUS_TAG = {
    "DomainStatus.active": "[OK]", "DomainStatus.suspended": "[BAN]",
    "DomainStatus.pending": "[PEND]", "DomainStatus.unknown": "[?]",
    "active": "[OK]", "suspended": "[BAN]",
    "pending": "[PEND]", "unknown": "[?]",
}


async def _lookup_domains(candidates: list[str]) -> dict[str, tuple]:
    """Return {name: (Domain, CloudflareAccount, Team)} for given names."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Domain, CloudflareAccount, Team)
            .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
            .outerjoin(Team, CloudflareAccount.team_id == Team.id)
            .where(Domain.name.in_(candidates))
        )
        return {d.name: (d, a, t) for d, a, t in result.all()}


async def _get_codeword() -> str:
    async with AsyncSessionLocal() as db:
        cfg = (await db.execute(
            select(BackupConfig).where(BackupConfig.id == 1)
        )).scalar_one_or_none()
        return (cfg.frontend_codeword or "").strip() if cfg else ""


# ── /fe — front-end mode lookup (any user, codeword-gated) ───────────────

@dp.message(F.text.startswith("/fe"))
@dp.edited_message(F.text.startswith("/fe"))
async def handle_fe(message: types.Message):
    """Usage: /fe <codeword> domain1 domain2 ...
    Returns OK/BAN/PEND + team name for any matched domain, gated by codeword.
    Lets non-admin front-end engineers verify ownership and team without
    granting them full admin role."""
    parts = (message.text or "").split(maxsplit=2)
    if len(parts) < 3:
        await message.reply(
            "<b>Front-end перевірка</b>\n\n"
            "Використання: <code>/fe &lt;кодове слово&gt; домен1 домен2 ...</code>\n\n"
            "Покаже статус + команду для кожного домену, якщо кодове слово вірне."
            + PLATFORM_FOOTER,
            parse_mode="HTML", disable_web_page_preview=True,
        )
        return

    provided_cw = parts[1].strip()
    rest = parts[2]

    stored_cw = await _get_codeword()
    if not stored_cw:
        await message.reply(
            "Front-end режим не налаштовано. Зверніться до адміна." + PLATFORM_FOOTER,
            parse_mode="HTML", disable_web_page_preview=True,
        )
        return
    if provided_cw != stored_cw:
        await message.reply("Невірне кодове слово." + PLATFORM_FOOTER,
                             parse_mode="HTML", disable_web_page_preview=True)
        return

    candidates = _parse_domains(rest)
    if not candidates:
        await message.reply(
            "Не знайдено доменів. Приклад: <code>/fe секрет example.com test.org</code>"
            + PLATFORM_FOOTER,
            parse_mode="HTML", disable_web_page_preview=True,
        )
        return

    found = await _lookup_domains(candidates)
    lines = []
    for domain in candidates:
        if domain in found:
            d, a, t = found[domain]
            tag = STATUS_TAG.get(str(d.zone_status), "[?]")
            team_str = t.name if t else "?"
            lines.append(
                f"{tag} <code>{domain}</code> — <b>{team_str}</b> · CF: <i>{a.name}</i>"
            )
        else:
            lines.append(f"[—] <code>{domain}</code> — немає в системі")

    chunks = [lines[i:i + 30] for i in range(0, len(lines), 30)]
    for idx, chunk in enumerate(chunks):
        text = "\n".join(chunk)
        if idx == len(chunks) - 1:
            text += PLATFORM_FOOTER
        await message.reply(text, parse_mode="HTML", disable_web_page_preview=True)


@dp.message()
@dp.edited_message()
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

    candidates = _parse_domains(message.text.strip())
    if not candidates:
        await message.reply(
            "Надішліть список доменів (по одному на рядок).\n"
            "Для перевірки з назвою команди (для не-адмінів) використай:\n"
            "<code>/fe &lt;кодове слово&gt; домен1 домен2</code>"
            + PLATFORM_FOOTER,
            parse_mode="HTML", disable_web_page_preview=True,
        )
        return

    is_admin = await _is_tg_admin(message.from_user.id)
    found = await _lookup_domains(candidates)

    lines = []
    for domain in candidates:
        if domain in found:
            if is_admin:
                d, a, t = found[domain]
                tag = STATUS_TAG.get(str(d.zone_status), "[?]")
                team_str = t.name if t else "?"
                lines.append(f"{tag} <code>{domain}</code> — <b>{team_str}</b>")
            else:
                lines.append(f"[OK] <code>{domain}</code> — є в системі")
        else:
            lines.append(f"[—] <code>{domain}</code> — немає в системі")

    # Send in chunks of 30 to stay under TG message limit
    chunks = [lines[i:i + 30] for i in range(0, len(lines), 30)]
    for idx, chunk in enumerate(chunks):
        text = "\n".join(chunk)
        if idx == len(chunks) - 1:
            text += PLATFORM_FOOTER
        await message.reply(text, parse_mode="HTML", disable_web_page_preview=True)


async def start_bot():
    b = get_bot()
    if b:
        asyncio.create_task(dp.start_polling(b))
