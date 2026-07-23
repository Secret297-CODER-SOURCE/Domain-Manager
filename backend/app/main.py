from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import logging

from app.db.session import engine, AsyncSessionLocal
from app.models.models import Base
from app.api import auth, teams, domains, keitaro, spreadsheets, keepass, proxies, backup as backup_api, purchases, kuma, identities, mail, services as services_api, notes, servers as servers_api, sheet_sync, sheet_import, dynadot as dynadot_api, public as public_api, notifications as notifications_api, payments as payments_api, external as external_api

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


async def daily_sync_job():
    """Runs every 24h — sync all CF accounts."""
    from app.services.cloudflare.cf_sync import sync_all_accounts
    async with AsyncSessionLocal() as db:
        stats = await sync_all_accounts(db)
        await db.commit()
    logger.info(f"[daily_sync] done: {stats}")


async def hourly_abuse_check():
    """Runs every 18 min — check for suspended zones, alert in TG."""
    from app.services.telegram_bot import check_all_zones
    await check_all_zones()


async def cf_abuse_refresh_job():
    """Runs every hour — live-fetch CF abuse reports for all active accounts
    and cache them. The Dashboard abuse widget and "Причини банів" stats card
    both read that cache instead of hitting Cloudflare on every page load."""
    from app.api.domains import refresh_cf_abuse_cache
    async with AsyncSessionLocal() as db:
        reports = await refresh_cf_abuse_cache(db)
    logger.info(f"[cf_abuse_refresh] cached {len(reports)} live abuse reports")


async def cleanup_old_logs():
    """Runs daily — delete ActionLog entries older than 7 days.
    Destructive actions (team/cf-account/domain removal) are kept for 180
    days instead — a 7-day trail on the one thing you'd actually want to
    investigate later ("who removed this and why") isn't enough."""
    from sqlalchemy import delete, text
    from app.models.models import ActionLog
    destructive_actions = ("team_delete", "cf_account_delete", "full_delete_cf")
    async with AsyncSessionLocal() as db:
        await db.execute(
            delete(ActionLog).where(
                ActionLog.created_at < text("NOW() - INTERVAL '7 days'"),
                ActionLog.action.notin_(destructive_actions),
            )
        )
        await db.execute(
            delete(ActionLog).where(
                ActionLog.created_at < text("NOW() - INTERVAL '180 days'"),
                ActionLog.action.in_(destructive_actions),
            )
        )
        await db.commit()
    logger.info("[cleanup] old logs deleted")


async def expiry_reminder_job():
    """Daily — warn about domains expiring in the next 4 days.

    Two signals are checked:
      * `Domain.expires_at` if Cloudflare/Dynadot sync populated it.
      * Fallback heuristic: `registered_at + 365d` (assumes 1-year reg).

    De-dup per domain: don't re-notify if we sent a reminder in the last
    20 hours (so the cron's daily cadence triggers exactly once per day,
    but a manual restart won't double-send).
    """
    from sqlalchemy import select, or_, and_, text as _text
    from app.models.models import Domain, CloudflareAccount, Team, ActionLog
    from app.services.telegram_bot import notify_admins
    from app.services.audit import log_action

    WARN_DAYS = 4

    async with AsyncSessionLocal() as db:
        # All candidates: real expiry within window OR estimated (registered + 1yr) within window
        q = (
            select(Domain, CloudflareAccount, Team)
            .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
            .outerjoin(Team, CloudflareAccount.team_id == Team.id)
            .where(
                or_(
                    and_(
                        Domain.expires_at.isnot(None),
                        Domain.expires_at > _text("NOW()"),
                        Domain.expires_at < _text(f"NOW() + INTERVAL '{WARN_DAYS} days'"),
                    ),
                    and_(
                        Domain.expires_at.is_(None),
                        Domain.registered_at.isnot(None),
                        Domain.registered_at < _text(f"NOW() - INTERVAL '{365 - WARN_DAYS} days'"),
                        Domain.registered_at > _text("NOW() - INTERVAL '365 days'"),
                    ),
                )
            )
        )
        candidates = (await db.execute(q)).all()

        # Filter out ones we already notified recently
        recently_notified = {
            r.domain for r in (await db.execute(
                select(ActionLog).where(
                    ActionLog.action == "domain_expiry_notified",
                    ActionLog.created_at > _text("NOW() - INTERVAL '20 hours'"),
                )
            )).scalars().all()
        }
        fresh = [(d, a, t) for d, a, t in candidates if d.name not in recently_notified]
        if not fresh:
            logger.info("[expiry_reminder] no fresh expiring domains")
            return

        # Group by team
        by_team: dict[str, list] = {}
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz
        now = _dt.now(_tz.utc)
        for d, a, t in fresh:
            tn = t.name if t else "—"
            effective = d.expires_at or (d.registered_at + _td(days=365) if d.registered_at else None)
            days_left = (effective - now).days if effective else None
            by_team.setdefault(tn, []).append({
                "name": d.name, "cf": a.name, "days_left": days_left,
                "estimated": d.expires_at is None,
            })
            log_action(db, "domain_expiry_notified", user="system", target=d.name,
                       details={"days_left": days_left, "estimated": d.expires_at is None,
                                "team": tn, "cf": a.name})
        await db.commit()

    # Compose TG message
    lines = [f"<b>[NAGADUVANNYA] Домени, які треба продовжити (≤{WARN_DAYS}д)</b>\n"]
    total = sum(len(v) for v in by_team.values())
    lines[0] = f"<b>[NAGADUVANNYA] Домени, що скоро завершуються (≤{WARN_DAYS}д) · всього {total}</b>\n"
    for team, items in sorted(by_team.items(), key=lambda x: -len(x[1])):
        lines.append(f"<b>{team}</b> ({len(items)}):")
        for it in sorted(items, key=lambda x: x["days_left"] if x["days_left"] is not None else 999):
            est = " <i>(≈)</i>" if it["estimated"] else ""
            d_left = it["days_left"]
            if d_left is None:
                marker = "?"
            elif d_left <= 0:
                marker = "<b>СЬОГОДНІ</b>"
            elif d_left == 1:
                marker = "<b>завтра</b>"
            else:
                marker = f"за {d_left}д"
            lines.append(f"  • <code>{it['name']}</code> — {marker}{est} · CF: <i>{it['cf']}</i>")
        lines.append("")
    lines.append("<i>(≈) — приблизна дата (registered_at + 1 рік), точну візьмемо з Dynadot/CF Registrar API</i>")

    await notify_admins("\n".join(lines))
    logger.info(f"[expiry_reminder] sent: {total} domains across {len(by_team)} teams")


async def server_payment_reminder_job():
    """Daily — when there are ≤4 days left until end of month, remind about
    paying for all the user's servers. Picks up team/provider context so the
    TG message is actionable.

    De-dup: keeps a 20h window via ActionLog `server_payment_reminded`, so
    if the cron fires twice the user doesn't get a second blast.
    """
    from sqlalchemy import select, text as _text
    from app.models.models import RemoteServer, Team, ActionLog
    from app.services.telegram_bot import notify_admins
    from app.services.audit import log_action
    from datetime import date as _date, timedelta as _td
    from calendar import monthrange

    today = _date.today()
    last_day = monthrange(today.year, today.month)[1]
    days_left = last_day - today.day

    if days_left > 4:
        logger.info(f"[server_payment] {days_left}d left to month end — too early")
        return

    async with AsyncSessionLocal() as db:
        servers = (await db.execute(
            select(RemoteServer).order_by(RemoteServer.team_id, RemoteServer.label)
        )).scalars().all()
        if not servers:
            return

        # Already notified in last 20 hours?
        notified = {
            r.domain for r in (await db.execute(
                select(ActionLog).where(
                    ActionLog.action == "server_payment_reminded",
                    ActionLog.created_at > _text("NOW() - INTERVAL '20 hours'"),
                )
            )).scalars().all()
        }
        fresh = [s for s in servers if s.label not in notified]
        if not fresh:
            logger.info("[server_payment] all servers already notified today")
            return

        team_by_id = {
            t.id: t.name for t in (await db.execute(select(Team))).scalars().all()
        }
        by_team: dict[str, list] = {}
        for s in fresh:
            tn = team_by_id.get(s.team_id) or "—"
            by_team.setdefault(tn, []).append({
                "label": s.label, "host": s.host,
                "provider": s.provider or "—",
            })
            log_action(
                db, "server_payment_reminded", user="system", target=s.label,
                details={"team": tn, "provider": s.provider, "host": s.host,
                         "days_left": days_left},
            )
        await db.commit()

    # Compose TG
    total = sum(len(v) for v in by_team.values())
    lines = [
        f"<b>[NAGADUVANNYA] Оплата серверів — {days_left}д до кінця місяця</b>",
        f"Всього серверів: <b>{total}</b>\n",
    ]
    for team, items in sorted(by_team.items(), key=lambda x: -len(x[1])):
        lines.append(f"<b>{team}</b> ({len(items)}):")
        for it in items:
            lines.append(
                f"  • <code>{it['label']}</code> · {it['host']} · "
                f"<i>{it['provider']}</i>"
            )
        lines.append("")
    await notify_admins("\n".join(lines))
    logger.info(f"[server_payment] sent: {total} servers across {len(by_team)} teams")


async def payment_due_reminder_job():
    """Daily — warn about recurring payments (licenses, KLO, servers, AI
    subscriptions, VDS) due within 5 days, so nothing lapses silently.

    De-dup: keeps a 20h window via ActionLog `payment_due_reminded`, keyed
    by payment label, so a cron that fires more than once a day doesn't
    double-blast. Overdue items (days_left < 0) keep re-notifying daily
    until someone marks them paid — that's intentional.
    """
    from sqlalchemy import select, text as _text
    from app.models.models import RecurringPayment, Team, ActionLog
    from app.services.telegram_bot import notify_admins
    from app.services.audit import log_action
    from datetime import timezone as _tz

    WARN_DAYS = 5
    CATEGORY_LABELS = {
        "license": "Ліцензії", "klo": "КЛО", "server": "Сервери",
        "ai": "Підписки AI", "vds": "ВДС", "other": "Інше",
    }

    async with AsyncSessionLocal() as db:
        q = (
            select(RecurringPayment, Team)
            .outerjoin(Team, RecurringPayment.team_id == Team.id)
            .where(
                RecurringPayment.next_due_at.isnot(None),
                RecurringPayment.next_due_at < _text(f"NOW() + INTERVAL '{WARN_DAYS} days'"),
            )
        )
        rows = (await db.execute(q)).all()
        if not rows:
            logger.info("[payment_due] nothing due soon")
            return

        notified = {
            r.domain for r in (await db.execute(
                select(ActionLog).where(
                    ActionLog.action == "payment_due_reminded",
                    ActionLog.created_at > _text("NOW() - INTERVAL '20 hours'"),
                )
            )).scalars().all()
        }
        fresh = [(p, t) for p, t in rows if p.label not in notified]
        if not fresh:
            logger.info("[payment_due] all due payments already notified today")
            return

        now = datetime.now(_tz.utc)
        by_category: dict[str, list] = {}
        for p, t in fresh:
            days_left = (p.next_due_at - now).days
            by_category.setdefault(p.category, []).append({
                "label": p.label, "provider": p.provider or "—",
                "team": t.name if t else "—", "days_left": days_left,
            })
            log_action(db, "payment_due_reminded", user="system", target=p.label,
                       details={"category": p.category, "days_left": days_left,
                                "provider": p.provider, "team": t.name if t else None})
        await db.commit()

    total = sum(len(v) for v in by_category.values())
    lines = [f"<b>[NAGADUVANNYA] Оплати, які треба зробити (≤{WARN_DAYS}д) · всього {total}</b>\n"]
    for cat, items in sorted(by_category.items(), key=lambda x: -len(x[1])):
        cat_label = CATEGORY_LABELS.get(cat, cat)
        lines.append(f"<b>{cat_label}</b> ({len(items)}):")
        for it in sorted(items, key=lambda x: x["days_left"]):
            d_left = it["days_left"]
            if d_left < 0: marker = f"<b>ПРОСТРОЧЕНО {-d_left}д</b>"
            elif d_left == 0: marker = "<b>СЬОГОДНІ</b>"
            elif d_left == 1: marker = "<b>завтра</b>"
            else: marker = f"за {d_left}д"
            lines.append(f"  • <code>{it['label']}</code> — {marker} · {it['provider']} · {it['team']}")
        lines.append("")
    await notify_admins("\n".join(lines))
    logger.info(f"[payment_due] sent: {total} payments across {len(by_category)} categories")


async def daily_stats_report():
    """Send daily domain stats per team to TG admins."""
    from app.services.telegram_bot import notify_admins
    from sqlalchemy import select, func, case, text as _text
    from app.models.models import Domain, CloudflareAccount, Team, ActionLog, DomainStatus
    async with AsyncSessionLocal() as db:
        # Per-team stats
        from sqlalchemy import case as _case
        q = (
            select(
                Team.name,
                func.count(Domain.id).label("total"),
                func.count(_case((Domain.zone_status == DomainStatus.active, 1))).label("active"),
                func.count(_case((Domain.zone_status == DomainStatus.suspended, 1))).label("suspended"),
                func.count(_case((Domain.zone_status == DomainStatus.pending, 1))).label("pending"),
            )
            .join(CloudflareAccount, CloudflareAccount.team_id == Team.id)
            .join(Domain, Domain.cf_account_id == CloudflareAccount.id)
            .group_by(Team.name)
            .order_by(func.count(Domain.id).desc())
        )
        rows = (await db.execute(q)).all()

        # Deleted in last 24h
        deleted_q = select(ActionLog).where(
            ActionLog.action == "full_delete_cf",
            ActionLog.created_at > _text("NOW() - INTERVAL '24 hours'"),
        ).order_by(ActionLog.created_at.desc())
        deleted = (await db.execute(deleted_q)).scalars().all()

    if not rows:
        return

    lines = ["<b>[STATS] Щоденна статистика доменів</b>\n"]
    for r in rows:
        sus = f" · suspended: {r.suspended}" if r.suspended else ""
        pend = f" · pending: {r.pending}" if r.pending else ""
        lines.append(f"<b>{r.name}</b>: {r.total} доменів · active: {r.active}{sus}{pend}")

    if deleted:
        lines.append(f"\n<b>[DELETED] За 24 год ({len(deleted)}):</b>")
        for d in deleted[:20]:
            lines.append(f"  • <code>{d.domain}</code>")
        if len(deleted) > 20:
            lines.append(f"  …і ще {len(deleted) - 20}")
    else:
        lines.append("\n<b>[OK]</b> Видалень за 24 год не було")

    await notify_admins("\n".join(lines))
    logger.info(f"[daily_stats] sent, {len(rows)} teams, {len(deleted)} deleted")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Migrations: add columns if missing
        for stmt in [
            "ALTER TABLE keitaro_instances ADD COLUMN IF NOT EXISTS cname VARCHAR(512)",
            "ALTER TABLE telegram_admins ALTER COLUMN chat_id DROP NOT NULL",
            "ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS username VARCHAR(64) UNIQUE",
            "ALTER TABLE domains ADD COLUMN IF NOT EXISTS name_servers VARCHAR(512)",
            "ALTER TABLE spreadsheets ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'local'",
            "ALTER TABLE spreadsheets ADD COLUMN IF NOT EXISTS external_url VARCHAR(1024)",
            "ALTER TABLE identities ADD COLUMN IF NOT EXISTS email VARCHAR(256)",
            "ALTER TABLE identities ADD COLUMN IF NOT EXISTS username VARCHAR(128)",
            "ALTER TABLE identities ADD COLUMN IF NOT EXISTS password VARCHAR(256)",
            "ALTER TABLE identities ADD COLUMN IF NOT EXISTS picture VARCHAR(512)",
            "ALTER TABLE keepass_vaults ADD COLUMN IF NOT EXISTS owner_master_enc TEXT",
            # Migrate ProtonMail Bridge accounts from container-local 127.0.0.1 to host-bridge
            "UPDATE mail_accounts SET imap_host='host.docker.internal' WHERE imap_host='127.0.0.1' AND imap_port=1143",
            "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS tags VARCHAR(512)",
            "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS notes TEXT",
            "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS linked_data TEXT",
            # User attribution for audit trail
            "ALTER TABLE cloudflare_accounts ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL",
            "ALTER TABLE dynadot_accounts ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL",
            "ALTER TABLE domains ADD COLUMN IF NOT EXISTS added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL",
            "ALTER TABLE backup_config ADD COLUMN IF NOT EXISTS frontend_codeword VARCHAR(128)",
            # Procurement metadata for remote servers
            "ALTER TABLE remote_servers ADD COLUMN IF NOT EXISTS provider VARCHAR(128)",
            "ALTER TABLE remote_servers ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ",
            "ALTER TABLE remote_servers ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL",
            "ALTER TABLE remote_servers ADD COLUMN IF NOT EXISTS provider_email VARCHAR(256)",
            "ALTER TABLE remote_servers ADD COLUMN IF NOT EXISTS provider_password_enc TEXT",
            # Soft-delete for abused/removed domains — keep row + history
            "ALTER TABLE domains ADD COLUMN IF NOT EXISTS removed_from_cf BOOLEAN DEFAULT FALSE",
            "ALTER TABLE domains ADD COLUMN IF NOT EXISTS abuse_reason VARCHAR(512)",
            # BurnCheck → Domain Manager: підтвердження лістингу в Siberguvenlik
            "ALTER TABLE domains ADD COLUMN IF NOT EXISTS siberguvenlik_listed BOOLEAN DEFAULT FALSE",
            "ALTER TABLE domains ADD COLUMN IF NOT EXISTS siberguvenlik_confirmed_at TIMESTAMPTZ",
            # Per-команда реєстрація BurnCheck-інстансів (webhook URL + власний
            # API-ключ + опційний IP-вайтліст) — заміна одного глобального
            # DOMAINGUARD_WEBHOOK_URL з .env.
            "CREATE TABLE IF NOT EXISTS burncheck_instances ("
            "id SERIAL PRIMARY KEY,"
            "team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,"
            "label VARCHAR(128) NOT NULL,"
            "webhook_url VARCHAR(512),"
            "api_key VARCHAR(128) NOT NULL UNIQUE,"
            "allowed_ip VARCHAR(64),"
            "created_at TIMESTAMPTZ DEFAULT now()"
            ")",
            # Soft-delete for teams — "deleting" a team must never
            # cascade-hard-delete its CF accounts/domains/DNS history.
            "ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE NOT NULL",
            # Persisted live CF abuse-report count per domain (refreshed
            # hourly, see cf_abuse_refresh_job / refresh_cf_abuse_cache).
            "ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_abuse_report_count INTEGER DEFAULT 0 NOT NULL",
        ]:
            try:
                await conn.execute(__import__('sqlalchemy').text(stmt))
            except Exception:
                pass

    await create_default_admin()

    # Auto-sync CF zones every hour — pulls zones + full DNS records for every
    # account. Original behaviour was daily 03:00. First run 60s after startup.
    scheduler.add_job(daily_sync_job, "interval", hours=1, id="daily_sync",
                      next_run_time=datetime.now() + timedelta(seconds=60))
    # Abuse check — every 18 min (was hourly). Zone-status checks now run
    # per-account with bounded concurrency (see ACCOUNT_CHECK_CONCURRENCY in
    # telegram_bot.py) + 429/5xx retry in cf_zones.get_zone_status, so a
    # shorter interval no longer risks hammering Cloudflare.
    scheduler.add_job(hourly_abuse_check, "interval", minutes=18, id="abuse_check")
    # Hourly live CF abuse-reports cache refresh — Dashboard reads the cache
    # instead of hitting Cloudflare on every page load. First run 90s after
    # startup so the cache isn't empty for the first visitor.
    scheduler.add_job(cf_abuse_refresh_job, "interval", hours=1, id="cf_abuse_refresh",
                      next_run_time=datetime.now() + timedelta(seconds=90))
    # Daily log cleanup at 04:00 UTC
    scheduler.add_job(cleanup_old_logs, "cron", hour=4, minute=0, id="log_cleanup")
    # Daily stats report at 09:00 UTC (12:00 Kyiv)
    scheduler.add_job(daily_stats_report, "cron", hour=9, minute=0, id="daily_stats")
    # Daily expiry reminder at 08:00 UTC (11:00 Kyiv) — warn 4 days before renewal
    scheduler.add_job(expiry_reminder_job, "cron", hour=8, minute=0, id="expiry_reminder")
    # Daily server-payment reminder at 08:30 UTC — fires only in the last
    # 4 days of each month; falls through harmlessly the rest of the time.
    scheduler.add_job(server_payment_reminder_job, "cron", hour=8, minute=30,
                      id="server_payment_reminder")
    # Daily recurring-payments reminder at 06:00 UTC (09:00 Kyiv) — warn 5
    # days before any license/KLO/server/AI-subscription/VDS payment is due.
    scheduler.add_job(payment_due_reminder_job, "cron", hour=6, minute=0,
                      id="payment_due_reminder")

    scheduler.start()
    logger.info("Scheduler started: cf_sync@1h (full DNS), abuse_check@hourly, cf_abuse_refresh@hourly, log_cleanup@04:00, expiry@08:00, server_payment@08:30, payment_due@06:00, daily_stats@09:00")

    # Restore backup schedule from persisted config
    try:
        from sqlalchemy import select as _select
        from app.models.models import BackupConfig
        async with AsyncSessionLocal() as _db:
            cfg = (await _db.execute(_select(BackupConfig).where(BackupConfig.id == 1))).scalar_one_or_none()
            if cfg and cfg.schedule_cron_hour is not None:
                reschedule_backup_job(cfg.schedule_cron_hour, cfg.schedule_cron_minute)
    except Exception:
        logger.exception("[backup] failed to load schedule from config")

    # Start TG bot
    from app.services.telegram_bot import start_bot
    await start_bot()

    yield
    scheduler.shutdown()


async def create_default_admin():
    from sqlalchemy import select
    from app.models.models import User, UserRole
    from app.core.security import hash_password
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User))
        if result.scalars().first() is None:
            admin = User(
                username="admin",
                hashed_password=hash_password("admin123"),
                role=UserRole.admin,
            )
            db.add(admin)
            await db.commit()
            logger.info("Default admin created: admin / admin123 — CHANGE THIS!")


app = FastAPI(title="Domain Manager", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(teams.router)
app.include_router(domains.router)
app.include_router(keitaro.router)
app.include_router(spreadsheets.router)
app.include_router(keepass.router)
app.include_router(proxies.router)
app.include_router(backup_api.router)
app.include_router(purchases.router)
app.include_router(kuma.router)
app.include_router(identities.router)
app.include_router(mail.router)
app.include_router(services_api.router)
app.include_router(notes.router)
app.include_router(servers_api.router)
app.include_router(sheet_sync.router)
app.include_router(sheet_import.router)
app.include_router(dynadot_api.router)
app.include_router(public_api.router)
app.include_router(notifications_api.router)
app.include_router(payments_api.router)
app.include_router(external_api.router)


# ── Backup scheduler control ──────────────────────────────────────────────
BACKUP_JOB_ID = "scheduled_backup"

def reschedule_backup_job(hour: int | None, minute: int):
    """Re-add or remove the cron job based on config."""
    try:
        scheduler.remove_job(BACKUP_JOB_ID)
    except Exception:
        pass
    if hour is not None:
        scheduler.add_job(
            backup_api.scheduled_backup_job, "cron",
            hour=int(hour), minute=int(minute), id=BACKUP_JOB_ID,
        )
        logger.info(f"[backup] scheduled at {hour:02d}:{minute:02d} UTC")
    else:
        logger.info("[backup] schedule disabled")


@app.get("/health")
async def health():
    return {"status": "ok", "version": "2.0.0"}
