"""Full-platform backup/restore.

Layout of the produced .zip:
  manifest.json                  — version, instance, created_at, counts, sha256 of db.json
  README.txt                     — human-readable summary
  db.json                        — every table as JSON (binary fields base64-encoded)
  files/vaults/{owner}/{name}.kdbx
  files/sheets/{owner}/{id}__{name}.json   (raw fortune-sheet payload)
  files/proxies/{owner}.txt                (one proxy per line, scheme://user:pass@host:port)
  files/logs/recent_logs.json

If encrypted: the zip itself is AES-256 encrypted (pyzipper).
"""
from __future__ import annotations
import io
import json
import base64
import hashlib
import re
from datetime import datetime, timezone, date
from typing import Optional

import pyzipper
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    User, Team, CloudflareAccount, KeitaroInstance, KeitaroDomainGroup,
    Domain, DnsRecord, AbuseAlert, ActionLog, TelegramAdmin,
    Spreadsheet, KeepassVault, KeepassShare, Proxy,
    BackupConfig, BackupRun, Purchase, KumaInstance,
)

BACKUP_VERSION = 1

# Tables exported into db.json. Order matters for restore (FK parents first).
# Each entry: (sa_model, ordered list of safe column names, set of binary cols → base64)
EXPORTED_TABLES = [
    ("users",                  User,                 None, set()),
    ("teams",                  Team,                 None, set()),
    ("cloudflare_accounts",    CloudflareAccount,    None, set()),
    ("keitaro_instances",      KeitaroInstance,      None, set()),
    ("keitaro_domain_groups",  KeitaroDomainGroup,   None, set()),
    ("domains",                Domain,               None, set()),
    ("dns_records",            DnsRecord,            None, set()),
    ("abuse_alerts",           AbuseAlert,           None, set()),
    ("action_logs",            ActionLog,            None, set()),
    ("telegram_admins",        TelegramAdmin,        None, set()),
    ("spreadsheets",           Spreadsheet,          None, set()),
    ("keepass_vaults",         KeepassVault,         None, {"blob"}),  # binary
    ("keepass_shares",         KeepassShare,         None, set()),
    ("proxies",                Proxy,                None, set()),
    ("purchases",              Purchase,             None, set()),
    ("kuma_instances",         KumaInstance,         None, set()),
    ("backup_config",          BackupConfig,         None, set()),
    # NOTE: backup_runs intentionally excluded — meta about backups themselves
]

_slug_re = re.compile(r"[^a-zA-Z0-9._-]+")
def _slug(s: str | None, default: str = "x") -> str:
    if not s:
        return default
    s = _slug_re.sub("_", s).strip("_")
    return s[:96] or default


def _row_to_dict(row, binary_cols: set[str]) -> dict:
    out = {}
    for col in row.__table__.columns:
        v = getattr(row, col.name)
        if isinstance(v, (datetime, date)):
            v = v.isoformat()
        elif isinstance(v, (bytes, bytearray, memoryview)):
            v = "base64:" + base64.b64encode(bytes(v)).decode("ascii")
        # Enum -> value
        elif hasattr(v, "value") and not isinstance(v, (int, str, bool, float)):
            v = v.value
        out[col.name] = v
    return out


def _decode_value(v):
    if isinstance(v, str) and v.startswith("base64:"):
        return base64.b64decode(v[7:])
    return v


# ── Build archive ─────────────────────────────────────────────────────────

async def gather_data(db: AsyncSession) -> tuple[dict, dict]:
    """Returns (db_json_dict, files_map). files_map is {archive_path: bytes}."""
    db_dump = {"version": BACKUP_VERSION, "tables": {}}
    counts: dict[str, int] = {}

    # Pull users first for name lookup
    users_rows = (await db.execute(select(User))).scalars().all()
    user_name = {u.id: u.username for u in users_rows}

    for name, model, _cols, binary in EXPORTED_TABLES:
        rows = (await db.execute(select(model))).scalars().all()
        db_dump["tables"][name] = [_row_to_dict(r, binary) for r in rows]
        counts[name] = len(rows)

    files: dict[str, bytes] = {}

    # Vaults — each .kdbx in its own file, signed by owner
    vaults = (await db.execute(select(KeepassVault))).scalars().all()
    for v in vaults:
        owner = _slug(user_name.get(v.owner_user_id), f"user{v.owner_user_id}")
        files[f"files/vaults/{owner}/{_slug(v.name, 'vault')}.kdbx"] = bytes(v.blob or b"")

    # Sheets — raw data as .json (encrypted ones stay encrypted strings)
    sheets = (await db.execute(select(Spreadsheet))).scalars().all()
    for s in sheets:
        owner = _slug(user_name.get(s.owner_user_id), f"user{s.owner_user_id}")
        body = {
            "id": s.id, "name": s.name,
            "owner": user_name.get(s.owner_user_id),
            "encrypted": (s.data or "").startswith("ENC1:"),
            "data": s.data,
            "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        }
        files[f"files/sheets/{owner}/{s.id}__{_slug(s.name, 'sheet')}.json"] = json.dumps(body, ensure_ascii=False, indent=2).encode()

    # Proxies — one .txt per owner with classic format
    proxies = (await db.execute(select(Proxy))).scalars().all()
    by_owner: dict[int, list[Proxy]] = {}
    for p in proxies:
        by_owner.setdefault(p.owner_user_id, []).append(p)
    for owner_id, lst in by_owner.items():
        owner = _slug(user_name.get(owner_id), f"user{owner_id}")
        lines = [f"# Proxies of {user_name.get(owner_id) or owner_id}", ""]
        for p in lst:
            scheme = "socks5" if p.type == "socks5" else "http"
            auth = f"{p.username}:{p.password or ''}@" if p.username else ""
            tag = f"  # {p.label or ''}{' [' + p.tags + ']' if p.tags else ''}".rstrip()
            lines.append(f"{scheme}://{auth}{p.host}:{p.port}{tag if tag.strip() != '#' else ''}")
        files[f"files/proxies/{owner}.txt"] = ("\n".join(lines) + "\n").encode()

    # Logs — recent 5000 actions
    logs = (await db.execute(select(ActionLog).order_by(ActionLog.created_at.desc()).limit(5000))).scalars().all()
    files["files/logs/recent_logs.json"] = json.dumps(
        [_row_to_dict(l, set()) for l in logs], ensure_ascii=False, indent=2
    ).encode()

    return {"db": db_dump, "counts": counts, "files": files, "user_name": user_name}


async def build_archive(db: AsyncSession, instance_name: str, password: Optional[str]) -> tuple[bytes, dict, str]:
    payload = await gather_data(db)
    counts = payload["counts"]

    db_json_bytes = json.dumps(payload["db"], ensure_ascii=False, indent=2).encode()
    db_sha256 = hashlib.sha256(db_json_bytes).hexdigest()

    manifest = {
        "version": BACKUP_VERSION,
        "instance": instance_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "encrypted": bool(password),
        "counts": counts,
        "db_sha256": db_sha256,
        "total_files": len(payload["files"]),
    }

    readme = _readme_text(manifest, payload["user_name"])

    buf = io.BytesIO()
    if password:
        zf = pyzipper.AESZipFile(buf, "w", compression=pyzipper.ZIP_LZMA, encryption=pyzipper.WZ_AES)
        zf.setpassword(password.encode())
    else:
        zf = pyzipper.AESZipFile(buf, "w", compression=pyzipper.ZIP_DEFLATED)

    with zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr("README.txt", readme)
        zf.writestr("db.json", db_json_bytes)
        for path, data in payload["files"].items():
            zf.writestr(path, data)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    filename = f"dm-backup-{_slug(instance_name)}-{ts}.zip"
    return buf.getvalue(), manifest, filename


def _readme_text(manifest: dict, user_name: dict[int, str]) -> str:
    counts = manifest["counts"]
    lines = [
        f"Domain Manager Backup",
        f"=====================",
        f"Instance: {manifest['instance']}",
        f"Created : {manifest['created_at']}",
        f"Version : {manifest['version']}",
        f"Encrypted (zip-AES256): {manifest['encrypted']}",
        f"DB SHA-256: {manifest['db_sha256']}",
        "",
        "Counts:",
    ]
    for k, v in counts.items():
        lines.append(f"  {k:25s} {v}")
    lines += [
        "",
        f"Users in this backup:",
    ]
    for uid, uname in user_name.items():
        lines.append(f"  [{uid}] {uname}")
    lines += [
        "",
        "How to restore:",
        "  1. Open Domain Manager → Бекапи → 'Відновити' → завантажте цей .zip",
        "  2. Якщо архів зашифрований — введіть пароль",
        "  3. Подивіться preview та підтвердіть",
        "",
        "Bookkeeping note:",
        "  Кожен файл у каталозі files/<тип>/<власник>/... підписаний username-ом власника,",
        "  тож навіть якщо БД пошкоджена — паролі та таблиці можна підняти вручну.",
    ]
    return "\n".join(lines) + "\n"


# ── Parse archive (for restore) ───────────────────────────────────────────

def parse_archive(zip_bytes: bytes, password: Optional[str]) -> dict:
    buf = io.BytesIO(zip_bytes)
    zf = pyzipper.AESZipFile(buf, "r")
    if password:
        zf.setpassword(password.encode())
    with zf:
        try:
            manifest = json.loads(zf.read("manifest.json"))
        except RuntimeError as e:
            # wrong password or not encrypted
            raise ValueError("Невірний пароль або пошкоджений архів") from e
        except KeyError:
            raise ValueError("manifest.json не знайдено — це не валідний бекап")

        db_bytes = zf.read("db.json")
        db_sha = hashlib.sha256(db_bytes).hexdigest()
        if manifest.get("db_sha256") and db_sha != manifest["db_sha256"]:
            raise ValueError("db.json sha256 не співпадає з manifest")
        db_dump = json.loads(db_bytes)
    return {"manifest": manifest, "db": db_dump}


# ── Restore ───────────────────────────────────────────────────────────────

async def restore_data(parsed: dict, db: AsyncSession, mode: str = "merge") -> dict:
    """
    mode='merge': upsert by PK. Existing rows updated, new inserted, missing kept.
    mode='replace': delete-all + insert (within transaction). DANGEROUS.
    """
    db_dump = parsed["db"]
    tables = db_dump.get("tables", {})

    if mode == "replace":
        # Delete in reverse FK order
        for name, model, _, _ in reversed(EXPORTED_TABLES):
            if name == "backup_config":
                continue  # don't wipe own config
            await db.execute(delete(model))

    stats: dict[str, dict] = {}
    for name, model, _cols, binary in EXPORTED_TABLES:
        rows = tables.get(name, [])
        inserted = updated = 0
        for raw in rows:
            data = {}
            for k, v in raw.items():
                if k in binary:
                    data[k] = _decode_value(v) if v else v
                elif isinstance(v, str) and v.startswith("base64:"):
                    data[k] = _decode_value(v)
                else:
                    # parse ISO timestamps back? SA accepts strings for DateTime; let it be.
                    data[k] = v

            pk = data.get("id")
            existing = await db.get(model, pk) if pk is not None else None
            if existing:
                for k, v in data.items():
                    if k == "id":
                        continue
                    setattr(existing, k, v)
                updated += 1
            else:
                obj = model(**data)
                db.add(obj)
                inserted += 1
        await db.flush()
        stats[name] = {"inserted": inserted, "updated": updated, "total": len(rows)}

    return stats


# ── Send to destinations ──────────────────────────────────────────────────

async def send_to_telegram(token: str, chat_id: str, content: bytes, filename: str, caption: str) -> dict:
    import httpx
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    # Telegram bot file limit = 50 MB
    if len(content) > 50 * 1024 * 1024:
        raise ValueError(f"Бекап {len(content) // (1024*1024)} MB > 50 MB ліміт Telegram bot API")
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(
            url,
            data={"chat_id": chat_id, "caption": caption[:1024]},
            files={"document": (filename, content, "application/zip")},
        )
    j = r.json()
    if not j.get("ok"):
        raise RuntimeError(f"Telegram: {j.get('description')}")
    return {"message_id": j["result"]["message_id"]}


async def send_to_sftp(host: str, port: int, username: str, password: str, remote_path: str,
                       content: bytes, filename: str) -> dict:
    import asyncssh
    target_dir = remote_path.rstrip("/") or "."
    async with asyncssh.connect(
        host, port=port, username=username, password=password,
        known_hosts=None,  # NB: production should pin host keys
    ) as conn:
        async with conn.start_sftp_client() as sftp:
            # mkdir -p
            parts = [p for p in target_dir.split("/") if p]
            cur = "/" if target_dir.startswith("/") else ""
            for p in parts:
                cur = (cur.rstrip("/") + "/" + p) if cur else p
                try:
                    await sftp.stat(cur)
                except (asyncssh.SFTPNoSuchFile, FileNotFoundError):
                    await sftp.mkdir(cur)
            full = f"{target_dir.rstrip('/')}/{filename}"
            async with sftp.open(full, "wb") as f:
                await f.write(content)
    return {"path": full}
