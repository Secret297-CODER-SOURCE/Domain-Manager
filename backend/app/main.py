from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from contextlib import asynccontextmanager
import logging

from app.db.session import engine, AsyncSessionLocal
from app.models.models import Base
from app.api import auth, teams, domains, keitaro, spreadsheets, keepass, proxies, backup as backup_api, purchases, kuma

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

    lines = ["📊 <b>Щоденна статистика доменів</b>\n"]
    for r in rows:
        sus = f" ⚠️{r.suspended}" if r.suspended else ""
        pend = f" ⏳{r.pending}" if r.pending else ""
        lines.append(f"👥 <b>{r.name}</b>: {r.total} доменів  ✅{r.active}{sus}{pend}")

    if deleted:
        lines.append(f"\n🗑 <b>Видалено за 24 год ({len(deleted)}):</b>")
        for d in deleted[:20]:
            lines.append(f"  • <code>{d.domain}</code>")
        if len(deleted) > 20:
            lines.append(f"  …і ще {len(deleted) - 20}")
    else:
        lines.append("\n✅ Видалень за 24 год не було")

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
        ]:
            try:
                await conn.execute(__import__('sqlalchemy').text(stmt))
            except Exception:
                pass

    await create_default_admin()

    # Daily sync at 03:00 UTC
    scheduler.add_job(daily_sync_job, "cron", hour=3, minute=0, id="daily_sync")
    # Hourly abuse check
    scheduler.add_job(hourly_abuse_check, "interval", hours=1, id="abuse_check")
    # Daily log cleanup at 04:00 UTC
    scheduler.add_job(cleanup_old_logs, "cron", hour=4, minute=0, id="log_cleanup")
    # Daily stats report at 09:00 UTC (12:00 Kyiv)
    scheduler.add_job(daily_stats_report, "cron", hour=9, minute=0, id="daily_stats")

    scheduler.start()
    logger.info("Scheduler started: daily_sync@03:00, abuse_check@hourly, log_cleanup@04:00, daily_stats@09:00")

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
