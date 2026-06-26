from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import logging

from app.db.session import engine, AsyncSessionLocal
from app.models.models import Base
from app.api import auth, teams, domains, keitaro, spreadsheets, keepass, proxies, backup as backup_api, purchases, kuma, identities, mail, services as services_api, notes, servers as servers_api, sheet_sync, sheet_import, dynadot as dynadot_api, public as public_api

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
    """Runs every hour — check for suspended zones, alert in TG."""
    from app.services.telegram_bot import check_all_zones
    await check_all_zones()


async def cleanup_old_logs():
    """Runs daily — delete ActionLog entries older than 7 days."""
    from sqlalchemy import delete, text
    from app.models.models import ActionLog
    async with AsyncSessionLocal() as db:
        await db.execute(
            delete(ActionLog).where(
                ActionLog.created_at < text("NOW() - INTERVAL '7 days'")
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
    # Hourly abuse check
    scheduler.add_job(hourly_abuse_check, "interval", hours=1, id="abuse_check")
    # Daily log cleanup at 04:00 UTC
    scheduler.add_job(cleanup_old_logs, "cron", hour=4, minute=0, id="log_cleanup")
    # Daily stats report at 09:00 UTC (12:00 Kyiv)
    scheduler.add_job(daily_stats_report, "cron", hour=9, minute=0, id="daily_stats")
    # Daily expiry reminder at 08:00 UTC (11:00 Kyiv) — warn 4 days before renewal
    scheduler.add_job(expiry_reminder_job, "cron", hour=8, minute=0, id="expiry_reminder")

    scheduler.start()
    logger.info("Scheduler started: cf_sync@1h (full DNS), abuse_check@hourly, log_cleanup@04:00, expiry@08:00, daily_stats@09:00")

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
