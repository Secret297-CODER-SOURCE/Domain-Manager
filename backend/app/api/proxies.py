from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional
import asyncio
import re
import time
import httpx

from app.db.session import get_db
from app.models.models import Proxy, User
from app.core.security import get_current_user

router = APIRouter(prefix="/api/proxies", tags=["proxies"])


class ProxyOut(BaseModel):
    id: int
    label: Optional[str]
    type: str
    host: str
    port: int
    username: Optional[str]
    password: Optional[str]
    country: Optional[str]
    tags: Optional[str]
    notes: Optional[str]
    is_active: bool
    last_check_at: Optional[datetime]
    last_check_ok: Optional[bool]
    last_check_ip: Optional[str]
    last_check_latency_ms: Optional[int]
    last_check_error: Optional[str]
    created_at: Optional[datetime]
    class Config:
        from_attributes = True


class ProxyIn(BaseModel):
    label: Optional[str] = None
    type: str = "http"
    host: str
    port: int
    username: Optional[str] = None
    password: Optional[str] = None
    country: Optional[str] = None
    tags: Optional[str] = None
    notes: Optional[str] = None
    is_active: bool = True


class ProxyPatch(BaseModel):
    label: Optional[str] = None
    type: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    country: Optional[str] = None
    tags: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class BulkImportIn(BaseModel):
    text: str
    default_type: str = "http"
    tags: Optional[str] = None


class BulkTestIn(BaseModel):
    ids: list[int]


# ── Parsing helpers ───────────────────────────────────────────────────────

# Accepts:
#   host:port
#   host:port:user:pass
#   user:pass@host:port
#   http://user:pass@host:port
#   socks5://host:port
def parse_proxy_line(line: str, default_type: str = "http") -> Optional[dict]:
    line = line.strip()
    if not line or line.startswith("#"):
        return None

    type_ = default_type
    m = re.match(r"^(https?|socks5|socks5h)://(.+)$", line, re.IGNORECASE)
    if m:
        type_ = m.group(1).lower()
        if type_ == "https": type_ = "http"
        if type_ == "socks5h": type_ = "socks5"
        line = m.group(2)

    user = pwd = None
    # split off user:pass@ if present
    if "@" in line:
        cred, addr = line.rsplit("@", 1)
        if ":" in cred:
            user, pwd = cred.split(":", 1)
        else:
            user = cred
    else:
        addr = line

    parts = addr.split(":")
    if len(parts) == 2:
        host, port = parts
    elif len(parts) == 4:
        # host:port:user:pass
        host, port, user, pwd = parts
    else:
        return None

    try:
        port_i = int(port)
    except ValueError:
        return None

    return {"type": type_, "host": host, "port": port_i, "username": user or None, "password": pwd or None}


def _build_proxy_url(p: Proxy) -> str:
    auth = ""
    if p.username:
        # urlencode minimally — colons/at-signs in passwords are rare in proxy lists
        from urllib.parse import quote
        auth = quote(p.username, safe="") + (":" + quote(p.password or "", safe="") if p.password else "") + "@"
    scheme = "socks5" if p.type == "socks5" else "http"
    return f"{scheme}://{auth}{p.host}:{p.port}"


# ── CRUD ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ProxyOut])
async def list_proxies(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Proxy).where(Proxy.owner_user_id == user.id).order_by(Proxy.id.desc())
    return (await db.execute(q)).scalars().all()


@router.post("", response_model=ProxyOut)
async def create_proxy(data: ProxyIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    p = Proxy(owner_user_id=user.id, **data.model_dump())
    db.add(p)
    await db.flush()
    await db.refresh(p)
    return p


@router.patch("/{pid}", response_model=ProxyOut)
async def update_proxy(pid: int, data: ProxyPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    p = await db.get(Proxy, pid)
    if not p or p.owner_user_id != user.id:
        raise HTTPException(404, "Proxy not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    await db.flush()
    await db.refresh(p)
    return p


@router.delete("/{pid}")
async def delete_proxy(pid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    p = await db.get(Proxy, pid)
    if not p or p.owner_user_id != user.id:
        raise HTTPException(404, "Proxy not found")
    await db.delete(p)
    return {"ok": True}


class BulkDeleteIn(BaseModel):
    ids: list[int]


@router.post("/bulk-delete")
async def bulk_delete(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Proxy).where(Proxy.id.in_(data.ids), Proxy.owner_user_id == user.id)
    rows = (await db.execute(q)).scalars().all()
    for p in rows:
        await db.delete(p)
    return {"deleted": len(rows)}


@router.post("/import")
async def import_proxies(data: BulkImportIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    created, skipped = 0, 0
    seen = set()
    # Existing host:port pairs for this user to dedupe
    existing = (await db.execute(
        select(Proxy.host, Proxy.port).where(Proxy.owner_user_id == user.id)
    )).all()
    seen = {(h, p) for h, p in existing}

    for raw in data.text.splitlines():
        parsed = parse_proxy_line(raw, data.default_type)
        if not parsed:
            skipped += 1
            continue
        key = (parsed["host"], parsed["port"])
        if key in seen:
            skipped += 1
            continue
        seen.add(key)
        p = Proxy(owner_user_id=user.id, tags=data.tags, **parsed)
        db.add(p)
        created += 1
    await db.flush()
    return {"created": created, "skipped": skipped}


# ── Test ──────────────────────────────────────────────────────────────────

CHECK_URL = "https://api.ipify.org?format=json"
CHECK_TIMEOUT = 10.0


async def _test_one(p: Proxy) -> dict:
    proxy_url = _build_proxy_url(p)
    transport = httpx.AsyncHTTPTransport(proxy=proxy_url)
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(transport=transport, timeout=CHECK_TIMEOUT) as c:
            r = await c.get(CHECK_URL)
        latency = int((time.monotonic() - start) * 1000)
        if r.status_code == 200:
            ip = (r.json() or {}).get("ip")
            return {"ok": True, "ip": ip, "latency_ms": latency, "error": None}
        return {"ok": False, "ip": None, "latency_ms": latency, "error": f"HTTP {r.status_code}"}
    except Exception as e:
        latency = int((time.monotonic() - start) * 1000)
        msg = str(e)[:500]
        return {"ok": False, "ip": None, "latency_ms": latency, "error": msg}


@router.post("/{pid}/test", response_model=ProxyOut)
async def test_proxy(pid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    p = await db.get(Proxy, pid)
    if not p or p.owner_user_id != user.id:
        raise HTTPException(404, "Proxy not found")
    r = await _test_one(p)
    p.last_check_at = datetime.now(timezone.utc)
    p.last_check_ok = r["ok"]
    p.last_check_ip = r["ip"]
    p.last_check_latency_ms = r["latency_ms"]
    p.last_check_error = r["error"]
    await db.flush()
    await db.refresh(p)
    return p


@router.post("/bulk-test")
async def bulk_test(data: BulkTestIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Proxy).where(Proxy.id.in_(data.ids), Proxy.owner_user_id == user.id)
    proxies = (await db.execute(q)).scalars().all()
    # Run with bounded concurrency
    sem = asyncio.Semaphore(10)
    async def run(p):
        async with sem:
            r = await _test_one(p)
            p.last_check_at = datetime.now(timezone.utc)
            p.last_check_ok = r["ok"]
            p.last_check_ip = r["ip"]
            p.last_check_latency_ms = r["latency_ms"]
            p.last_check_error = r["error"]
            return {"id": p.id, **r}
    results = await asyncio.gather(*[run(p) for p in proxies])
    await db.flush()
    ok = sum(1 for r in results if r["ok"])
    return {"total": len(results), "ok": ok, "fail": len(results) - ok, "results": results}
