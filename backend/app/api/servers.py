"""Remote-server management:
- CRUD over RemoteServer rows
- POST /test → quick SSH handshake (optionally through a SOCKS/HTTP proxy)
- WebSocket /ws/{id} → interactive terminal: browser <-> WS <-> asyncssh PTY
- POST /web-tunnel → returns iframe-proxy URL for the server's HTTP panel

All passwords/keys are stored Fernet-encrypted. SSH connection can be tunneled
through a row in the Proxy table (SOCKS5 / HTTP CONNECT).
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Optional, List

import asyncssh
import time
import logging
import aiohttp
import httpx
from urllib.parse import urlparse, quote as urlquote
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, Request, Response, UploadFile, File, Form, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.services import iframe_proxy

logger = logging.getLogger(__name__)

from app.core.crypto import encrypt_secret, decrypt_secret
from app.core.config import settings
from app.core.security import get_current_user
from app.services.audit import log_action
from jose import jwt, JWTError
from app.db.session import get_db, AsyncSessionLocal
from app.models.models import RemoteServer, Proxy, User, Domain, DnsRecord, Spreadsheet
from app.services.sheet_mirror import mirror_entity_to_sheets


router = APIRouter(prefix="/api/servers", tags=["servers"])


# ── Schemas ─────────────────────────────────────────────────────────────

class ServerOut(BaseModel):
    id: int
    label: str
    host: str
    port: int
    username: str
    auth_kind: str
    proxy_id: Optional[int]
    web_url: Optional[str]
    tags: Optional[str]
    notes: Optional[str]
    linked_sheet_id: Optional[int]
    last_status: Optional[str]
    last_status_at: Optional[datetime]
    last_error: Optional[str]
    created_at: Optional[datetime]
    class Config:
        from_attributes = True


class ServerIn(BaseModel):
    label: str
    host: str
    port: int = 22
    username: str = "root"
    auth_kind: str = "password"     # password | key
    password: Optional[str] = None
    private_key: Optional[str] = None
    proxy_id: Optional[int] = None
    web_url: Optional[str] = None
    tags: Optional[str] = None
    notes: Optional[str] = None


class ServerPatch(BaseModel):
    label: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    auth_kind: Optional[str] = None
    password: Optional[str] = None
    private_key: Optional[str] = None
    proxy_id: Optional[int] = None
    web_url: Optional[str] = None
    tags: Optional[str] = None
    notes: Optional[str] = None
    linked_sheet_id: Optional[int] = None


# ── Helpers ──────────────────────────────────────────────────────────────

async def _owned(db: AsyncSession, sid: int, user: User) -> RemoteServer:
    s = await db.get(RemoteServer, sid)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Сервер не знайдено")
    return s


async def _load_proxy(db: AsyncSession, pid: Optional[int]) -> Optional[Proxy]:
    if not pid:
        return None
    return await db.get(Proxy, pid)


async def _open_tunnel_socket(proxy: Proxy, target_host: str, target_port: int):
    """Open a raw TCP socket to target_host:target_port via SOCKS5/HTTP proxy.
    Returns a connected socket.socket object (NOT wrapped by asyncio)."""
    if proxy.type == "socks5":
        from python_socks.async_.asyncio import Proxy as SocksProxy
        url = f"socks5://{proxy.username}:{proxy.password}@{proxy.host}:{proxy.port}" \
              if proxy.username else f"socks5://{proxy.host}:{proxy.port}"
        sp = SocksProxy.from_url(url)
        sock = await sp.connect(dest_host=target_host, dest_port=target_port)
        return sock
    elif proxy.type == "http":
        import socket as _socket, base64
        loop = asyncio.get_event_loop()
        sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        sock.setblocking(False)
        await loop.sock_connect(sock, (proxy.host, proxy.port))
        req = f"CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n"
        if proxy.username:
            cred = base64.b64encode(f"{proxy.username}:{proxy.password or ''}".encode()).decode()
            req += f"Proxy-Authorization: Basic {cred}\r\n"
        req += "\r\n"
        await loop.sock_sendall(sock, req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = await loop.sock_recv(sock, 4096)
            if not chunk: raise HTTPException(502, "HTTP CONNECT closed early")
            buf += chunk
            if len(buf) > 8192: break
        line = buf.split(b"\r\n", 1)[0]
        if b" 200 " not in line:
            raise HTTPException(502, f"HTTP CONNECT failed: {line!r}")
        return sock
    else:
        raise HTTPException(400, f"Непідтримуваний тип проксі: {proxy.type}")


def _humanize_ssh_error(e: Exception, s: "RemoteServer") -> str:
    """Translate asyncssh/asyncio errors into a single sentence the user can act on."""
    cls = e.__class__.__name__
    msg = (str(e) or "").strip()
    low = msg.lower()
    if isinstance(e, (asyncio.TimeoutError,)) or "timed out" in low or "timeout" in low:
        return ("Тайм-аут підключення. "
                + ("Перевірте, чи проксі живий і чи доступний з нього SSH-порт." if s.proxy_id
                   else "Сервер не відповів за 15 сек — перевірте host/port або додайте проксі."))
    if "permission denied" in low or "auth" in low and "fail" in low or cls == "PermissionDenied":
        return ("Авторизація відхилена. Перевірте логін/пароль" +
                (" або SSH-ключ." if s.auth_kind == "key" else "."))
    if "refused" in low or "connectionrefused" in cls.lower():
        return "З'єднання відхилено — SSH-порт закритий на сервері або хибний порт."
    if "no route" in low or "unreachable" in low:
        return "Хост недоступний — перевірте host/port або мережу."
    if "host key" in low or "verification" in low:
        return f"Проблема з host-key: {msg[:200]}"
    if "no matching" in low:
        return f"Несумісні алгоритми SSH: {msg[:200]}"
    # Fallback — show class + message
    return f"{cls}: {msg[:280]}" if msg else cls


async def _ssh_connect(s: RemoteServer, db: AsyncSession, *, term: bool = False):
    """Open asyncssh connection, optionally through proxy_id. Returns asyncssh.SSHClientConnection."""
    proxy = await _load_proxy(db, s.proxy_id)

    kwargs = dict(
        host=s.host, port=s.port, username=s.username,
        known_hosts=None, connect_timeout=10,
        # Keep auth methods explicit; default 'gssapi' tries kerberos which can hang.
        preferred_auth=("publickey",) if s.auth_kind == "key" else ("password", "keyboard-interactive"),
    )
    if s.auth_kind == "password":
        if not s.password_enc:
            raise HTTPException(400, "Пароль не задано")
        kwargs["password"] = decrypt_secret(s.password_enc)
    else:
        if not s.private_key_enc:
            raise HTTPException(400, "Приватний ключ не задано")
        try:
            key = asyncssh.import_private_key(decrypt_secret(s.private_key_enc))
        except Exception as e:
            raise HTTPException(400, f"Невалідний ключ: {e}")
        kwargs["client_keys"] = [key]

    if proxy:
        sock = await _open_tunnel_socket(proxy, s.host, s.port)
        sock.setblocking(False)
        kwargs.pop("host"); kwargs.pop("port")
        return await asyncssh.connect(sock=sock, **kwargs)

    return await asyncssh.connect(**kwargs)


# ── CRUD ─────────────────────────────────────────────────────────────────

@router.get("", response_model=List[ServerOut])
async def list_servers(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(RemoteServer).where(RemoteServer.owner_user_id == user.id).order_by(RemoteServer.id.desc())
    return (await db.execute(q)).scalars().all()


@router.post("", response_model=ServerOut)
async def create_server(data: ServerIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = RemoteServer(
        owner_user_id=user.id,
        label=data.label,
        host=data.host, port=data.port, username=data.username,
        auth_kind=data.auth_kind,
        password_enc=encrypt_secret(data.password) if data.password else None,
        private_key_enc=encrypt_secret(data.private_key) if data.private_key else None,
        proxy_id=data.proxy_id, web_url=data.web_url,
        tags=data.tags, notes=data.notes,
    )
    db.add(s)
    log_action(db, "server_add", user=user, target=data.label,
               details={"host": data.host, "auth": data.auth_kind})
    await db.flush(); await db.refresh(s)
    await mirror_entity_to_sheets(db, entity_kind="servers", owner_user_id=user.id)
    return s


@router.patch("/{sid}", response_model=ServerOut)
async def update_server(sid: int, data: ServerPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    changes = {}
    for k, v in data.model_dump(exclude_unset=True).items():
        if k == "password":
            if v: s.password_enc = encrypt_secret(v); changes["password_rotated"] = True
        elif k == "private_key":
            if v: s.private_key_enc = encrypt_secret(v); changes["key_rotated"] = True
        else:
            setattr(s, k, v); changes[k] = v
    log_action(db, "server_update", user=user, target=s.label, details=changes)
    await db.flush(); await db.refresh(s)
    await mirror_entity_to_sheets(db, entity_kind="servers", owner_user_id=user.id)
    return s


@router.delete("/{sid}")
async def delete_server(sid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    log_action(db, "server_delete", user=user, target=s.label, details={"host": s.host})
    await db.delete(s)
    await db.flush()
    await mirror_entity_to_sheets(db, entity_kind="servers", owner_user_id=user.id)
    return {"ok": True}


@router.post("/{sid}/test", response_model=ServerOut)
async def test_server(sid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    try:
        conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=12)
        try:
            r = await conn.run("uname -a && uptime", check=False, timeout=8)
            s.last_status = "ok"
            s.last_error = (r.stdout or "").strip()[:480]
        finally:
            conn.close()
            try: await conn.wait_closed()
            except Exception: pass
    except Exception as e:
        s.last_status = "error"
        s.last_error = _humanize_ssh_error(e, s)[:480]
    s.last_status_at = datetime.now(timezone.utc)
    await db.flush(); await db.refresh(s)
    return s


# ── Linked data (domains + sheet rows pointing to this server) ────────

@router.get("/{sid}/linked")
async def server_linked(sid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Return everything that references this server's host/IP:
    - Cloudflare domains whose A-record / main_record_value matches
    - Rows from any of the user's spreadsheets that mention the host or IP."""
    s = await _owned(db, sid, user)
    host = (s.host or "").strip()
    if not host:
        return {"domains": [], "sheet_rows": []}

    targets = {host.lower()}
    # If host is a hostname, also include any IPs we already know about for it
    # — skipped for now; we just key by host string equality.

    # 1) Domains: main_record_value match
    q_main = (
        select(Domain)
        .join(Domain.cf_account)
        .where(Domain.main_record_value == host)
    )
    domains_main = (await db.execute(q_main)).scalars().all()

    # DNS records (A) match
    q_dns = (
        select(Domain, DnsRecord)
        .join(DnsRecord, DnsRecord.domain_id == Domain.id)
        .where(DnsRecord.value == host)
    )
    dns_matches = (await db.execute(q_dns)).all()

    # Build a unique map by domain.id
    domain_map: dict[int, dict] = {}
    for d in domains_main:
        domain_map[d.id] = {
            "id": d.id, "name": d.name,
            "main_record_type": d.main_record_type.value if d.main_record_type else None,
            "main_record_value": d.main_record_value,
            "zone_status": d.zone_status.value if d.zone_status else None,
            "via": "main_record",
        }
    for d, rec in dns_matches:
        if d.id in domain_map:
            domain_map[d.id]["via"] = "main_record + dns"
        else:
            domain_map[d.id] = {
                "id": d.id, "name": d.name,
                "main_record_type": d.main_record_type.value if d.main_record_type else None,
                "main_record_value": d.main_record_value,
                "zone_status": d.zone_status.value if d.zone_status else None,
                "via": f"DNS {rec.record_type.value if rec.record_type else 'A'} → {rec.name}",
            }

    domains_out = sorted(domain_map.values(), key=lambda x: x["name"])

    # 2) Sheet rows that mention the host
    import json as _json
    sheets_q = select(Spreadsheet).where(Spreadsheet.owner_user_id == user.id)
    sheet_rows_out: list[dict] = []
    needle_lc = host.lower()
    for sh in (await db.execute(sheets_q)).scalars().all():
        if not sh.data or sh.data.startswith("ENC1:"):
            continue
        try:
            wb = _json.loads(sh.data or "[]")
        except Exception:
            continue
        if not isinstance(wb, list):
            continue
        for sheet_obj in wb:
            cd = sheet_obj.get("celldata") or []
            if not cd:
                continue
            max_r = max(c["r"] for c in cd)
            max_c = max(c["c"] for c in cd)
            grid = [["" for _ in range(max_c + 1)] for _ in range(max_r + 1)]
            for cell in cd:
                v = cell.get("v") or {}
                val = v.get("v") if isinstance(v, dict) else v
                grid[cell["r"]][cell["c"]] = "" if val is None else str(val)
            if not grid:
                continue
            headers = [(h or "").strip() or f"col{i+1}" for i, h in enumerate(grid[0])]
            for row in grid[1:]:
                joined = " ".join(row).lower()
                if needle_lc in joined:
                    sheet_rows_out.append({
                        "sheet_id": sh.id,
                        "sheet_name": sh.name,
                        "tab_name": sheet_obj.get("name") or "",
                        "data": {headers[i]: row[i] for i in range(min(len(headers), len(row))) if i < len(row)},
                    })

    return {"domains": domains_out, "sheet_rows": sheet_rows_out, "host": host}


# ── SFTP ────────────────────────────────────────────────────────────────

import stat as _stat
import posixpath


def _sftp_entry(name: str, attrs) -> dict:
    mode = int(attrs.permissions or 0)
    is_dir = _stat.S_ISDIR(mode)
    is_link = _stat.S_ISLNK(mode)
    return {
        "name": name,
        "is_dir": is_dir,
        "is_link": is_link,
        "size": int(attrs.size) if attrs.size is not None else 0,
        "mtime": int(attrs.mtime) if attrs.mtime is not None else 0,
        "mode": mode & 0o7777,
    }


class SftpPathIn(BaseModel):
    path: str


class SftpRenameIn(BaseModel):
    src: str
    dst: str


@router.get("/{sid}/sftp/ls")
async def sftp_ls(sid: int, path: str = "", db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    try:
        conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=12)
    except Exception as e:
        raise HTTPException(502, _humanize_ssh_error(e, s))
    try:
        async with conn.start_sftp_client() as sftp:
            target = path or await sftp.realpath(".")
            try:
                names = await sftp.listdir(target)
            except Exception as e:
                raise HTTPException(400, f"listdir({target}): {e}")
            entries = []
            for name in names:
                if name in (".", ".."):
                    continue
                full = posixpath.join(target, name)
                try:
                    attrs = await sftp.lstat(full)
                    entries.append(_sftp_entry(name, attrs))
                except Exception:
                    continue
            entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
            return {"path": target, "entries": entries}
    finally:
        conn.close()
        try: await conn.wait_closed()
        except Exception: pass


@router.get("/{sid}/sftp/download")
async def sftp_download(sid: int, path: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    try:
        conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=12)
    except Exception as e:
        raise HTTPException(502, _humanize_ssh_error(e, s))

    async def stream():
        try:
            async with conn.start_sftp_client() as sftp:
                async with sftp.open(path, "rb") as f:
                    while True:
                        chunk = await f.read(65536)
                        if not chunk:
                            break
                        yield chunk
        finally:
            conn.close()
            try: await conn.wait_closed()
            except Exception: pass

    filename = posixpath.basename(path) or "download"
    safe = urlquote(filename, safe="")
    return StreamingResponse(
        stream(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe}"},
    )


@router.post("/{sid}/sftp/upload")
async def sftp_upload(
    sid: int,
    path: str = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    s = await _owned(db, sid, user)
    try:
        conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=12)
    except Exception as e:
        raise HTTPException(502, _humanize_ssh_error(e, s))
    try:
        dest = posixpath.join(path, file.filename) if path else file.filename
        async with conn.start_sftp_client() as sftp:
            async with sftp.open(dest, "wb") as f:
                while True:
                    chunk = await file.read(65536)
                    if not chunk:
                        break
                    await f.write(chunk)
        return {"ok": True, "path": dest}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"upload: {e}")
    finally:
        conn.close()
        try: await conn.wait_closed()
        except Exception: pass


@router.post("/{sid}/sftp/mkdir")
async def sftp_mkdir(sid: int, data: SftpPathIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    try:
        conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=12)
    except Exception as e:
        raise HTTPException(502, _humanize_ssh_error(e, s))
    try:
        async with conn.start_sftp_client() as sftp:
            await sftp.mkdir(data.path)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(400, f"mkdir: {e}")
    finally:
        conn.close()
        try: await conn.wait_closed()
        except Exception: pass


@router.delete("/{sid}/sftp/rm")
async def sftp_rm(sid: int, path: str, recursive: bool = False, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    try:
        conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=12)
    except Exception as e:
        raise HTTPException(502, _humanize_ssh_error(e, s))
    try:
        async with conn.start_sftp_client() as sftp:
            attrs = await sftp.lstat(path)
            if _stat.S_ISDIR(int(attrs.permissions or 0)):
                if recursive:
                    await sftp.rmtree(path)
                else:
                    await sftp.rmdir(path)
            else:
                await sftp.remove(path)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(400, f"rm: {e}")
    finally:
        conn.close()
        try: await conn.wait_closed()
        except Exception: pass


@router.post("/{sid}/sftp/rename")
async def sftp_rename(sid: int, data: SftpRenameIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await _owned(db, sid, user)
    try:
        conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=12)
    except Exception as e:
        raise HTTPException(502, _humanize_ssh_error(e, s))
    try:
        async with conn.start_sftp_client() as sftp:
            await sftp.rename(data.src, data.dst)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(400, f"rename: {e}")
    finally:
        conn.close()
        try: await conn.wait_closed()
        except Exception: pass


# ── WebSocket terminal ──────────────────────────────────────────────────

@router.websocket("/ws/{sid}")
async def ws_terminal(websocket: WebSocket, sid: int, token: str):
    """Interactive PTY shell. Frontend connects with ?token=<JWT> in the URL.
    Protocol:
      Browser → server: text frames = stdin bytes
                        JSON {type:"resize", cols, rows} for tty resize
      Server → browser: text frames = stdout/stderr bytes
                        JSON {type:"closed", code, error?} on disconnect
    """
    await websocket.accept()

    # Auth via JWT in query
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise JWTError("no sub")
    except Exception:
        await websocket.send_text(json.dumps({"type": "closed", "error": "auth"}))
        await websocket.close(code=4401); return

    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not user:
            await websocket.send_text(json.dumps({"type": "closed", "error": "user"}))
            await websocket.close(code=4401); return
        s = await db.get(RemoteServer, sid)
        if not s or s.owner_user_id != user.id:
            await websocket.send_text(json.dumps({"type": "closed", "error": "not_found"}))
            await websocket.close(code=4404); return

        try:
            conn = await asyncio.wait_for(_ssh_connect(s, db), timeout=15)
        except Exception as e:
            err = _humanize_ssh_error(e, s)
            logger.warning("ssh connect failed sid=%s: %s", sid, err)
            try:
                await websocket.send_text(json.dumps({"type": "closed", "error": err}))
            except Exception: pass
            try: await websocket.close(code=4500)
            except Exception: pass
            return

    # Outside DB block — spawn shell
    try:
        process = await conn.create_process(
            term_type="xterm-256color", term_size=(80, 24),
            stderr=asyncssh.STDOUT,
        )
    except Exception as e:
        logger.exception("shell open failed sid=%s", sid)
        err = str(e) or e.__class__.__name__
        try:
            await websocket.send_text(json.dumps({"type": "closed", "error": f"shell: {err}"}))
        except Exception: pass
        try: await websocket.close(code=4500)
        except Exception: pass
        conn.close()
        try: await conn.wait_closed()
        except Exception: pass
        return

    stop = asyncio.Event()

    async def pipe_out():
        try:
            while not stop.is_set():
                chunk = await process.stdout.read(4096)
                if not chunk:
                    break
                if isinstance(chunk, bytes):
                    chunk = chunk.decode("utf-8", errors="replace")
                await websocket.send_text(chunk)
        except Exception:
            pass
        finally:
            stop.set()

    async def pipe_in():
        try:
            while not stop.is_set():
                msg = await websocket.receive_text()
                if msg.startswith("{") and '"resize"' in msg:
                    try:
                        d = json.loads(msg)
                        if d.get("type") == "resize":
                            process.change_terminal_size(int(d["cols"]), int(d["rows"]))
                            continue
                    except Exception:
                        pass
                process.stdin.write(msg)
        except WebSocketDisconnect:
            stop.set()
        except Exception:
            stop.set()

    try:
        await asyncio.gather(pipe_out(), pipe_in())
    finally:
        try: process.close()
        except Exception: pass
        try:
            conn.close(); await conn.wait_closed()
        except Exception: pass
        try: await websocket.close()
        except Exception: pass


# ── Inline web-panel proxy (HTTP + WebSocket, iframed) ───────────────────

PROXY_COOKIE_PREFIX = "srv_proxy_"
PROXY_TTL_SECONDS = 3600


def _issue_proxy_token(username: str, sid: int) -> str:
    return jwt.encode(
        {"sub": username, "sid": sid, "purpose": "srv_proxy",
         "exp": int(time.time()) + PROXY_TTL_SECONDS},
        settings.SECRET_KEY, algorithm=settings.ALGORITHM,
    )


def _verify_proxy_token(token: str, sid: int) -> Optional[str]:
    try:
        p = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
    if p.get("purpose") != "srv_proxy" or p.get("sid") != sid:
        return None
    return p.get("sub")


async def _outbound_proxy_url(db: AsyncSession, s: RemoteServer) -> Optional[str]:
    if not s.proxy_id:
        return None
    p = await db.get(Proxy, s.proxy_id)
    if not p:
        return None
    auth = ""
    if p.username:
        auth = urlquote(p.username, safe="") + (":" + urlquote(p.password or "", safe="") if p.password else "") + "@"
    scheme = "socks5" if p.type == "socks5" else "http"
    return f"{scheme}://{auth}{p.host}:{p.port}"


@router.post("/{sid}/web-grant")
async def web_grant(sid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Issue cookie that authorizes /web/<path> HTTP+WS proxy to this server."""
    s = await _owned(db, sid, user)
    if not s.web_url:
        raise HTTPException(400, "У сервера не задано web_url")
    token = _issue_proxy_token(user.username, sid)
    resp = JSONResponse({
        "ok": True, "expires_in": PROXY_TTL_SECONDS,
        "url": f"/api/servers/{sid}/web/",
    })
    resp.set_cookie(
        key=f"{PROXY_COOKIE_PREFIX}{sid}",
        value=token, max_age=PROXY_TTL_SECONDS,
        httponly=True, samesite="strict",
        path=f"/api/servers/{sid}/",
    )
    return resp


@router.api_route(
    "/{sid}/web/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def web_http_proxy(sid: int, path: str, request: Request):
    cookie = request.cookies.get(f"{PROXY_COOKIE_PREFIX}{sid}")
    if not cookie:
        raise HTTPException(401, "Web-доступ не дозволено")
    username = _verify_proxy_token(cookie, sid)
    if not username:
        raise HTTPException(401, "Токен невалідний")

    async with AsyncSessionLocal() as sess:
        u = (await sess.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not u:
            raise HTTPException(401, "User not found")
        s = await sess.get(RemoteServer, sid)
        if not s or s.owner_user_id != u.id or not s.web_url:
            raise HTTPException(404, "Not found")
        outbound_proxy = await _outbound_proxy_url(sess, s)
        service_url = s.web_url

    p = urlparse(service_url)
    origin = f"{p.scheme}://{p.netloc}"
    target = f"{origin}/{path}" if path else f"{origin}/"
    if request.url.query:
        target += "?" + request.url.query

    fwd_headers = {h: v for h, v in request.headers.items()
                   if h.lower() not in iframe_proxy.DROP_REQ_HEADERS}
    fwd_headers["Host"] = p.netloc

    body_bytes = await request.body() if request.method not in ("GET", "HEAD") else None
    try:
        async with httpx.AsyncClient(
            timeout=45, follow_redirects=False, proxy=outbound_proxy, verify=False,
        ) as c:
            upstream = await c.request(request.method, target, content=body_bytes, headers=fwd_headers)
    except Exception as e:
        return Response(content=f"Proxy error: {e}", status_code=502, media_type="text/plain")

    prefix = f"/api/servers/{sid}/web"
    ws_prefix = f"/api/servers/{sid}/web-ws"

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

    return Response(content=content, status_code=upstream.status_code,
                    headers=out_headers, media_type=ctype or None)


@router.websocket("/{sid}/web-ws/{path:path}")
async def web_ws_proxy(websocket: WebSocket, sid: int, path: str):
    cookie = websocket.cookies.get(f"{PROXY_COOKIE_PREFIX}{sid}")
    if not cookie:
        await websocket.close(code=1008); return
    username = _verify_proxy_token(cookie, sid)
    if not username:
        await websocket.close(code=1008); return

    async with AsyncSessionLocal() as sess:
        u = (await sess.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not u:
            await websocket.close(code=1008); return
        s = await sess.get(RemoteServer, sid)
        if not s or s.owner_user_id != u.id or not s.web_url:
            await websocket.close(code=1008); return
        service_url = s.web_url

    p = urlparse(service_url)
    scheme = "wss" if p.scheme == "https" else "ws"
    qs = str(websocket.url.query)
    upstream_url = f"{scheme}://{p.netloc}/{path}"
    if qs: upstream_url += "?" + qs

    proto = (websocket.headers.get("sec-websocket-protocol", "") or "").split(",")[0].strip() or None
    await websocket.accept(subprotocol=proto)

    try:
        session = aiohttp.ClientSession()
        try:
            async with session.ws_connect(
                upstream_url, heartbeat=25, max_msg_size=0,
                headers={"User-Agent": "DomainManager-Srv-Proxy/1.0"},
            ) as upstream:
                async def c2u():
                    try:
                        while True:
                            msg = await websocket.receive()
                            if msg.get("type") == "websocket.disconnect": break
                            if msg.get("text") is not None: await upstream.send_str(msg["text"])
                            elif msg.get("bytes") is not None: await upstream.send_bytes(msg["bytes"])
                    except Exception: pass
                    finally:
                        try: await upstream.close()
                        except Exception: pass
                async def u2c():
                    try:
                        async for msg in upstream:
                            if msg.type == aiohttp.WSMsgType.TEXT: await websocket.send_text(msg.data)
                            elif msg.type == aiohttp.WSMsgType.BINARY: await websocket.send_bytes(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR): break
                    except Exception: pass
                    finally:
                        try: await websocket.close()
                        except Exception: pass
                t1 = asyncio.create_task(c2u()); t2 = asyncio.create_task(u2c())
                _, pending = await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                    try: await t
                    except Exception: pass
        finally:
            await session.close()
    except Exception:
        try: await websocket.close(code=1011)
        except Exception: pass
