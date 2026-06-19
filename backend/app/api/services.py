"""Generic external-service embed proxy. Lets the user pin Cloudflare,
ProtonMail, registrars, etc. as inline cards in the platform and view them
through our backend proxy (optionally routed via a user-defined Proxy).

For services that absolutely require their real origin (Proton webmail E2E, 2FA
challenges), `embed_mode=popup` falls back to opening in a separate window."""
from __future__ import annotations
import asyncio
import base64
import hashlib
import logging
import time
from typing import Optional
from urllib.parse import urlparse, quote as urlquote

import aiohttp
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import get_current_user
from app.db.session import AsyncSessionLocal, get_db
from app.models.models import EmbeddedService, Proxy, User
from app.services import iframe_proxy

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/services", tags=["services"])


# ── Built-in presets ─────────────────────────────────────────────────────

# embed_mode notes:
#   inline = our HTTP/WS proxy (works for vanilla SPAs)
#   popup  = open as separate browser window (only realistic option for sites
#            with anti-bot challenges / E2E / SSO / strict X-Frame-Options)
PRESETS = {
    "cloudflare":  {"label": "Cloudflare",     "url": "https://dash.cloudflare.com",        "kind": "cloudflare", "color": "#f48120", "icon": "Cloud",        "embed_mode": "popup"},
    "proton-mail": {"label": "ProtonMail",     "url": "https://mail.proton.me",             "kind": "proton",     "color": "#6d4aff", "icon": "ShieldCheck",  "embed_mode": "popup"},
    "namecheap":   {"label": "Namecheap",      "url": "https://ap.www.namecheap.com",       "kind": "registrar",  "color": "#de3910", "icon": "Globe",        "embed_mode": "popup"},
    "porkbun":     {"label": "Porkbun",        "url": "https://porkbun.com/account/login",  "kind": "registrar",  "color": "#ef758a", "icon": "Globe",        "embed_mode": "popup"},
    "godaddy":     {"label": "GoDaddy",        "url": "https://sso.godaddy.com",            "kind": "registrar",  "color": "#1bdbdb", "icon": "Globe",        "embed_mode": "popup"},
    "hetzner":     {"label": "Hetzner Cloud",  "url": "https://console.hetzner.cloud",      "kind": "hosting",    "color": "#d50c2d", "icon": "Server",       "embed_mode": "popup"},
    "digitalocean":{"label": "DigitalOcean",   "url": "https://cloud.digitalocean.com",     "kind": "hosting",    "color": "#0080ff", "icon": "Server",       "embed_mode": "popup"},
    "aws":         {"label": "AWS Console",    "url": "https://console.aws.amazon.com",     "kind": "hosting",    "color": "#ff9900", "icon": "Server",       "embed_mode": "popup"},
    "google-cloud":{"label": "Google Cloud",   "url": "https://console.cloud.google.com",   "kind": "hosting",    "color": "#4285f4", "icon": "Server",       "embed_mode": "popup"},
    "vercel":      {"label": "Vercel",         "url": "https://vercel.com/dashboard",       "kind": "hosting",    "color": "#000000", "icon": "Server",       "embed_mode": "popup"},
    "github":      {"label": "GitHub",         "url": "https://github.com",                 "kind": "code",       "color": "#24292f", "icon": "Code",         "embed_mode": "popup"},
}


@router.get("/presets")
async def get_presets(_: User = Depends(get_current_user)):
    return PRESETS


# ── Schemas ──────────────────────────────────────────────────────────────

class ServiceIn(BaseModel):
    label: str
    url: str
    kind: str = "generic"
    color: Optional[str] = None
    icon: Optional[str] = None
    notes: Optional[str] = None
    proxy_id: Optional[int] = None
    sort_order: int = 0
    embed_mode: str = "inline"


class ServiceOut(BaseModel):
    id: int
    label: str
    url: str
    kind: str
    color: Optional[str]
    icon: Optional[str]
    notes: Optional[str]
    proxy_id: Optional[int]
    proxy_label: Optional[str] = None
    sort_order: int
    embed_mode: str

    class Config:
        from_attributes = True


# ── CRUD ─────────────────────────────────────────────────────────────────

async def _service_to_out(s: EmbeddedService, db: AsyncSession) -> ServiceOut:
    out = ServiceOut.model_validate(s)
    if s.proxy_id:
        p = await db.get(Proxy, s.proxy_id)
        if p:
            out.proxy_label = p.label or f"{p.host}:{p.port}"
    return out


@router.get("", response_model=list[ServiceOut])
async def list_services(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(EmbeddedService).where(EmbeddedService.owner_user_id == user.id).order_by(
        EmbeddedService.sort_order, EmbeddedService.id,
    )
    rows = (await db.execute(q)).scalars().all()
    return [await _service_to_out(s, db) for s in rows]


@router.post("", response_model=ServiceOut)
async def create_service(data: ServiceIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    if data.proxy_id:
        p = await db.get(Proxy, data.proxy_id)
        if not p or p.owner_user_id != user.id:
            raise HTTPException(404, "Proxy not found")
    s = EmbeddedService(owner_user_id=user.id, **data.model_dump())
    db.add(s)
    await db.flush()
    await db.refresh(s)
    return await _service_to_out(s, db)


@router.patch("/{sid}", response_model=ServiceOut)
async def update_service(sid: int, data: ServiceIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await db.get(EmbeddedService, sid)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Service not found")
    if data.proxy_id:
        p = await db.get(Proxy, data.proxy_id)
        if not p or p.owner_user_id != user.id:
            raise HTTPException(404, "Proxy not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    await db.flush()
    await db.refresh(s)
    return await _service_to_out(s, db)


@router.delete("/{sid}")
async def delete_service(sid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await db.get(EmbeddedService, sid)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Service not found")
    await db.delete(s)
    return {"ok": True}


# ── Probe (X-Frame-Options check) ────────────────────────────────────────

@router.get("/{sid}/probe")
async def probe_service(sid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await db.get(EmbeddedService, sid)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Service not found")
    out = {"url": s.url, "reachable": False, "status": None,
           "x_frame_options": None, "csp_frame_ancestors": None, "error": None}
    try:
        proxies = await _proxy_url_for(db, s) if s.proxy_id else None
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, proxy=proxies) as c:
            r = await c.get(s.url)
        out["reachable"] = True
        out["status"] = r.status_code
        out["x_frame_options"] = r.headers.get("x-frame-options")
        csp = r.headers.get("content-security-policy", "")
        for part in csp.split(";"):
            p = part.strip().lower()
            if p.startswith("frame-ancestors"):
                out["csp_frame_ancestors"] = p[len("frame-ancestors"):].strip()
                break
    except Exception as e:
        out["error"] = str(e)[:300]
    return out


# ── Proxy embedding (HTTP + WebSocket) ───────────────────────────────────

PROXY_COOKIE_PREFIX = "svc_proxy_"
PROXY_TTL_SECONDS = 3600


def _issue_proxy_token(username: str, sid: int) -> str:
    return jwt.encode(
        {"sub": username, "sid": sid, "purpose": "svc_proxy",
         "exp": int(time.time()) + PROXY_TTL_SECONDS},
        settings.SECRET_KEY, algorithm=settings.ALGORITHM,
    )


def _verify_proxy_token(token: str, sid: int) -> Optional[str]:
    try:
        p = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
    if p.get("purpose") != "svc_proxy" or p.get("sid") != sid:
        return None
    return p.get("sub")


async def _proxy_url_for(db: AsyncSession, s: EmbeddedService) -> Optional[str]:
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


@router.post("/{sid}/proxy-grant")
async def grant_proxy(sid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    s = await db.get(EmbeddedService, sid)
    if not s or s.owner_user_id != user.id:
        raise HTTPException(404, "Service not found")
    token = _issue_proxy_token(user.username, sid)
    resp = JSONResponse({"ok": True, "expires_in": PROXY_TTL_SECONDS, "url": s.url})
    resp.set_cookie(
        key=f"{PROXY_COOKIE_PREFIX}{sid}",
        value=token,
        max_age=PROXY_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        path=f"/api/services/{sid}/",
    )
    return resp


@router.api_route(
    "/{sid}/proxy/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def http_proxy(sid: int, path: str, request: Request, db: AsyncSession = Depends(get_db)):
    cookie = request.cookies.get(f"{PROXY_COOKIE_PREFIX}{sid}")
    if not cookie:
        raise HTTPException(401, "Proxy not granted")
    username = _verify_proxy_token(cookie, sid)
    if not username:
        raise HTTPException(401, "Proxy token invalid")

    async with AsyncSessionLocal() as sess:
        user = (await sess.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not user:
            raise HTTPException(401, "User not found")
        s = await sess.get(EmbeddedService, sid)
        if not s or s.owner_user_id != user.id:
            raise HTTPException(404, "Not found")
        outbound_proxy = await _proxy_url_for(sess, s)
        service_url = s.url

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
            timeout=45, follow_redirects=False, proxy=outbound_proxy,
        ) as c:
            upstream = await c.request(request.method, target, content=body_bytes, headers=fwd_headers)
    except Exception as e:
        return Response(content=f"Proxy error: {e}", status_code=502, media_type="text/plain")

    prefix = f"/api/services/{sid}/proxy"
    ws_prefix = f"/api/services/{sid}/proxy-ws"

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


@router.websocket("/{sid}/proxy-ws/{path:path}")
async def ws_proxy(websocket: WebSocket, sid: int, path: str):
    cookie = websocket.cookies.get(f"{PROXY_COOKIE_PREFIX}{sid}")
    if not cookie:
        await websocket.close(code=1008); return
    username = _verify_proxy_token(cookie, sid)
    if not username:
        await websocket.close(code=1008); return

    async with AsyncSessionLocal() as sess:
        user = (await sess.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not user:
            await websocket.close(code=1008); return
        s = await sess.get(EmbeddedService, sid)
        if not s or s.owner_user_id != user.id:
            await websocket.close(code=1008); return
        service_url = s.url

    p = urlparse(service_url)
    scheme = "wss" if p.scheme == "https" else "ws"
    qs = str(websocket.url.query)
    upstream_url = f"{scheme}://{p.netloc}/{path}"
    if qs:
        upstream_url += "?" + qs

    proto = (websocket.headers.get("sec-websocket-protocol", "") or "").split(",")[0].strip() or None
    await websocket.accept(subprotocol=proto)

    try:
        session = aiohttp.ClientSession()
        try:
            async with session.ws_connect(
                upstream_url, heartbeat=25, max_msg_size=0,
                headers={"User-Agent": "DomainManager-Svc-Proxy/1.0"},
            ) as upstream:
                async def c2u():
                    try:
                        while True:
                            msg = await websocket.receive()
                            if msg.get("type") == "websocket.disconnect": break
                            if msg.get("text") is not None: await upstream.send_str(msg["text"])
                            elif msg.get("bytes") is not None: await upstream.send_bytes(msg["bytes"])
                    except (WebSocketDisconnect, Exception): pass
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
