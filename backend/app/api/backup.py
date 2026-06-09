from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional
import json
import logging

from app.db.session import get_db, AsyncSessionLocal
from app.models.models import BackupConfig, BackupRun, User
from app.core.security import require_admin
from app.core.config import settings
from app.services import backup as bkp

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backup", tags=["backup"])


# ── Schemas ───────────────────────────────────────────────────────────────

class BackupConfigOut(BaseModel):
    instance_name: str
    encryption_enabled: bool
    schedule_cron_hour: Optional[int]
    schedule_cron_minute: int
    retention_count: int
    tg_enabled: bool
    tg_chat_id: Optional[str]
    tg_uses_env_token: bool
    sftp_enabled: bool
    sftp_host: Optional[str]
    sftp_port: Optional[int]
    sftp_username: Optional[str]
    sftp_path: Optional[str]


class BackupConfigIn(BaseModel):
    instance_name: str = "domain-manager"
    encryption_password: Optional[str] = None  # null = no password / leave existing if empty string?
    clear_encryption: bool = False             # explicit clear
    schedule_cron_hour: Optional[int] = None
    schedule_cron_minute: int = 0
    retention_count: int = 14

    tg_enabled: bool = False
    tg_bot_token: Optional[str] = None
    clear_tg_token: bool = False
    tg_chat_id: Optional[str] = None

    sftp_enabled: bool = False
    sftp_host: Optional[str] = None
    sftp_port: Optional[int] = 22
    sftp_username: Optional[str] = None
    sftp_password: Optional[str] = None
    clear_sftp_password: bool = False
    sftp_path: Optional[str] = "/"


class BackupRunOut(BaseModel):
    id: int
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    status: str
    trigger: str
    size_bytes: Optional[int]
    filename: Optional[str]
    destinations: Optional[str]
    error: Optional[str]
    counts: Optional[dict] = None
    triggered_by: Optional[str]

    class Config:
        from_attributes = True


# ── Singleton config helpers ──────────────────────────────────────────────

async def _get_or_create_config(db: AsyncSession) -> BackupConfig:
    c = await db.get(BackupConfig, 1)
    if not c:
        c = BackupConfig(id=1)
        db.add(c)
        await db.flush()
        await db.refresh(c)
    return c


def _config_to_out(c: BackupConfig) -> BackupConfigOut:
    return BackupConfigOut(
        instance_name=c.instance_name,
        encryption_enabled=bool(c.encryption_password),
        schedule_cron_hour=c.schedule_cron_hour,
        schedule_cron_minute=c.schedule_cron_minute,
        retention_count=c.retention_count,
        tg_enabled=c.tg_enabled,
        tg_chat_id=c.tg_chat_id,
        tg_uses_env_token=not bool(c.tg_bot_token) and bool(settings.TELEGRAM_BOT_TOKEN),
        sftp_enabled=c.sftp_enabled,
        sftp_host=c.sftp_host,
        sftp_port=c.sftp_port,
        sftp_username=c.sftp_username,
        sftp_path=c.sftp_path,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────

@router.get("/config", response_model=BackupConfigOut)
async def get_config(db: AsyncSession = Depends(get_db), _: User = Depends(require_admin)):
    c = await _get_or_create_config(db)
    return _config_to_out(c)


@router.put("/config", response_model=BackupConfigOut)
async def set_config(data: BackupConfigIn, db: AsyncSession = Depends(get_db), _: User = Depends(require_admin)):
    c = await _get_or_create_config(db)
    c.instance_name = data.instance_name or "domain-manager"
    c.schedule_cron_hour = data.schedule_cron_hour
    c.schedule_cron_minute = max(0, min(59, data.schedule_cron_minute))
    c.retention_count = max(1, min(365, data.retention_count))

    if data.clear_encryption:
        c.encryption_password = None
    elif data.encryption_password is not None and data.encryption_password != "":
        c.encryption_password = data.encryption_password

    c.tg_enabled = data.tg_enabled
    c.tg_chat_id = data.tg_chat_id or None
    if data.clear_tg_token:
        c.tg_bot_token = None
    elif data.tg_bot_token:
        c.tg_bot_token = data.tg_bot_token

    c.sftp_enabled = data.sftp_enabled
    c.sftp_host = data.sftp_host or None
    c.sftp_port = data.sftp_port or 22
    c.sftp_username = data.sftp_username or None
    c.sftp_path = data.sftp_path or "/"
    if data.clear_sftp_password:
        c.sftp_password = None
    elif data.sftp_password:
        c.sftp_password = data.sftp_password

    await db.flush()
    await db.refresh(c)

    # Reschedule the cron job
    try:
        from app.main import reschedule_backup_job
        reschedule_backup_job(c.schedule_cron_hour, c.schedule_cron_minute)
    except Exception:
        logger.exception("reschedule_backup_job failed")

    return _config_to_out(c)


@router.get("/runs", response_model=list[BackupRunOut])
async def list_runs(db: AsyncSession = Depends(get_db), _: User = Depends(require_admin)):
    q = select(BackupRun).order_by(BackupRun.id.desc()).limit(100)
    rows = (await db.execute(q)).scalars().all()
    out = []
    for r in rows:
        d = BackupRunOut.model_validate(r)
        if r.counts:
            try: d.counts = json.loads(r.counts)
            except Exception: pass
        out.append(d)
    return out


@router.delete("/runs/{run_id}")
async def delete_run(run_id: int, db: AsyncSession = Depends(get_db), _: User = Depends(require_admin)):
    r = await db.get(BackupRun, run_id)
    if not r:
        raise HTTPException(404, "Run not found")
    await db.delete(r)
    return {"ok": True}


@router.post("/run")
async def run_backup(
    destinations: str = Query("download", description="csv: download,tg,sftp"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """Build a backup and send to the requested destinations. Returns run metadata.
    If 'download' is in destinations, the binary is also returned via /api/backup/last-download/<run_id>.
    """
    c = await _get_or_create_config(db)
    targets = [x.strip() for x in destinations.split(",") if x.strip()]
    if not targets:
        raise HTTPException(400, "No destinations")

    run = BackupRun(trigger="manual", triggered_by=user.username, destinations=",".join(targets), status="running")
    db.add(run)
    await db.flush()
    run_id = run.id

    try:
        zip_bytes, manifest, filename = await bkp.build_archive(db, c.instance_name, c.encryption_password)
        caption = (
            f"📦 Backup {c.instance_name}\n"
            f"🕒 {manifest['created_at']}\n"
            f"🔒 {'AES256' if manifest['encrypted'] else 'plain'}  ·  📂 {len(zip_bytes)//1024} KB\n"
            f"👤 by {user.username}"
        )
        sent_to = []

        if "tg" in targets:
            if not c.tg_enabled:
                raise HTTPException(400, "Telegram destination disabled in config")
            token = c.tg_bot_token or settings.TELEGRAM_BOT_TOKEN
            if not token or not c.tg_chat_id:
                raise HTTPException(400, "Telegram token/chat_id missing")
            await bkp.send_to_telegram(token, c.tg_chat_id, zip_bytes, filename, caption)
            sent_to.append("tg")

        if "sftp" in targets:
            if not c.sftp_enabled:
                raise HTTPException(400, "SFTP destination disabled in config")
            if not (c.sftp_host and c.sftp_username and c.sftp_password):
                raise HTTPException(400, "SFTP host/user/password missing")
            await bkp.send_to_sftp(
                c.sftp_host, c.sftp_port or 22, c.sftp_username, c.sftp_password,
                c.sftp_path or "/", zip_bytes, filename,
            )
            sent_to.append("sftp")

        run.status = "ok"
        run.size_bytes = len(zip_bytes)
        run.filename = filename
        run.counts = json.dumps(manifest["counts"])
        run.finished_at = datetime.now(timezone.utc)
        run.destinations = ",".join(sent_to + (["download"] if "download" in targets else []))
        await db.flush()

        # Retention: keep N most-recent successful runs metadata
        await _apply_retention(db, c.retention_count)

        # Hand the binary back via response if download requested
        if "download" in targets:
            return Response(
                content=zip_bytes,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "X-Backup-Run-Id": str(run_id),
                    "X-Backup-Counts": json.dumps(manifest["counts"]),
                },
            )
        return {"ok": True, "run_id": run_id, "filename": filename, "size_bytes": len(zip_bytes), "sent_to": sent_to}

    except Exception as e:
        run.status = "error"
        run.error = str(e)[:2000]
        run.finished_at = datetime.now(timezone.utc)
        await db.flush()
        if isinstance(e, HTTPException):
            raise
        logger.exception("Backup failed")
        raise HTTPException(500, f"Backup failed: {e}")


async def _apply_retention(db: AsyncSession, keep: int):
    # Keep the last `keep` successful runs; drop older ok runs. Errors retained separately (last 50).
    ok_q = select(BackupRun).where(BackupRun.status == "ok").order_by(BackupRun.id.desc())
    ok_rows = (await db.execute(ok_q)).scalars().all()
    for r in ok_rows[keep:]:
        await db.delete(r)
    err_q = select(BackupRun).where(BackupRun.status == "error").order_by(BackupRun.id.desc())
    err_rows = (await db.execute(err_q)).scalars().all()
    for r in err_rows[50:]:
        await db.delete(r)


# ── Restore ───────────────────────────────────────────────────────────────

@router.post("/preview")
async def preview_restore(
    file: UploadFile = File(...),
    password: str = Form(""),
    _: User = Depends(require_admin),
):
    content = await file.read()
    try:
        parsed = bkp.parse_archive(content, password or None)
    except Exception as e:
        raise HTTPException(400, str(e))
    return {"manifest": parsed["manifest"]}


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    password: str = Form(""),
    mode: str = Form("merge"),  # merge | replace
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if mode not in ("merge", "replace"):
        raise HTTPException(400, "mode must be merge|replace")
    content = await file.read()
    try:
        parsed = bkp.parse_archive(content, password or None)
    except Exception as e:
        raise HTTPException(400, str(e))
    stats = await bkp.restore_data(parsed, db, mode=mode)
    return {"ok": True, "mode": mode, "manifest": parsed["manifest"], "stats": stats}


# ── Scheduler entry-point (called by main.py job) ─────────────────────────

async def scheduled_backup_job():
    async with AsyncSessionLocal() as db:
        c = await _get_or_create_config(db)
        if not c.tg_enabled and not c.sftp_enabled:
            logger.info("[backup] no destinations enabled, skipping")
            return
        run = BackupRun(trigger="schedule", triggered_by="system", status="running")
        db.add(run)
        await db.flush()
        try:
            zip_bytes, manifest, filename = await bkp.build_archive(db, c.instance_name, c.encryption_password)
            caption = (
                f"📦 Scheduled backup {c.instance_name}\n"
                f"🕒 {manifest['created_at']}\n"
                f"🔒 {'AES256' if manifest['encrypted'] else 'plain'}  ·  📂 {len(zip_bytes)//1024} KB"
            )
            sent = []
            if c.tg_enabled:
                token = c.tg_bot_token or settings.TELEGRAM_BOT_TOKEN
                if token and c.tg_chat_id:
                    await bkp.send_to_telegram(token, c.tg_chat_id, zip_bytes, filename, caption)
                    sent.append("tg")
            if c.sftp_enabled and c.sftp_host and c.sftp_username and c.sftp_password:
                await bkp.send_to_sftp(
                    c.sftp_host, c.sftp_port or 22, c.sftp_username, c.sftp_password,
                    c.sftp_path or "/", zip_bytes, filename,
                )
                sent.append("sftp")
            run.status = "ok"
            run.size_bytes = len(zip_bytes)
            run.filename = filename
            run.destinations = ",".join(sent)
            run.counts = json.dumps(manifest["counts"])
            run.finished_at = datetime.now(timezone.utc)
            await _apply_retention(db, c.retention_count)
            logger.info(f"[backup] scheduled ok: {filename} → {sent}")
        except Exception as e:
            run.status = "error"
            run.error = str(e)[:2000]
            run.finished_at = datetime.now(timezone.utc)
            logger.exception("[backup] scheduled failed")
        await db.commit()
