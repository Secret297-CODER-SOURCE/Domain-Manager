from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
import asyncio
import logging
import re
import time
from urllib.parse import urlparse

from jose import jwt, JWTError
import httpx
import aiohttp

from app.db.session import get_db, AsyncSessionLocal
from app.models.models import KumaInstance, User
from app.core.security import get_current_user
from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/kuma", tags=["kuma"])


class KumaOut(BaseModel):
    id: int
    name: str
    url: str
    color: Optional[str]
    sort_order: int
    notes: Optional[str]
    created_at: Optional[datetime]
    class Config:
        from_attributes = True


class KumaIn(BaseModel):
    name: str
    url: str
    color: Optional[str] = None
    sort_order: int = 0
    notes: Optional[str] = None


@router.get("", response_model=list[KumaOut])
async def list_kuma(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(KumaInstance).where(KumaInstance.owner_user_id == user.id).order_by(KumaInstance.sort_order, KumaInstance.id)
    return (await db.execute(q)).scalars().all()


@router.post("", response_model=KumaOut)
async def create(data: KumaIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    k = KumaInstance(owner_user_id=user.id, **data.model_dump())
    db.add(k)
    await db.flush()
    await db.refresh(k)
    return k


@router.patch("/{kid}", response_model=KumaOut)
async def update(kid: int, data: KumaIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    k = await db.get(KumaInstance, kid)
    if not k or k.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    for f, v in data.model_dump(exclude_unset=True).items():
        setattr(k, f, v)
    await db.flush()
    await db.refresh(k)
    return k


@router.delete("/{kid}")
async def delete(kid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    k = await db.get(KumaInstance, kid)
    if not k or k.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    await db.delete(k)
    return {"ok": True}


@router.get("/{kid}/probe")
async def probe(kid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Server-side reachability + X-Frame-Options check for the Kuma URL."""
    import httpx
    k = await db.get(KumaInstance, kid)
    if not k or k.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    out = {"url": k.url, "reachable": False, "status": None, "x_frame_options": None, "csp_frame_ancestors": None, "error": None}
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as c:
            r = await c.get(k.url)
        out["reachable"] = True
        out["status"] = r.status_code
        out["x_frame_options"] = r.headers.get("x-frame-options")
        # parse CSP frame-ancestors
        csp = r.headers.get("content-security-policy", "")
        for part in csp.split(";"):
            p = part.strip().lower()
            if p.startswith("frame-ancestors"):
                out["csp_frame_ancestors"] = p[len("frame-ancestors"):].strip()
                break
    except Exception as e:
        out["error"] = str(e)[:300]
    return out


# ── Embedded HTTP proxy ──────────────────────────────────────────────────
# Lets the iframe load the Kuma dashboard same-origin and strips the
# X-Frame-Options/CSP headers that block embedding. Best-effort: HTML and
# absolute paths are rewritten so static assets load through the proxy too.
# Live WebSocket updates won't flow through (Kuma uses socket.io); the dashboard
# still renders with initial server state.

PROXY_COOKIE_PREFIX = "kuma_proxy_"
PROXY_TTL_SECONDS = 3600


def _issue_proxy_token(user: User, kid: int) -> str:
    payload = {
        "sub": user.username, "kid": kid, "purpose": "kuma_proxy",
        "exp": int(time.time()) + PROXY_TTL_SECONDS,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def _verify_proxy_token(token: str, kid: int) -> str | None:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
    if payload.get("purpose") != "kuma_proxy" or payload.get("kid") != kid:
        return None
    return payload.get("sub")


@router.post("/{kid}/proxy-grant")
async def grant_proxy(kid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Issue a short-lived cookie that authorizes /proxy/* loads via iframe."""
    k = await db.get(KumaInstance, kid)
    if not k or k.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    token = _issue_proxy_token(user, kid)
    resp = JSONResponse({"ok": True, "expires_in": PROXY_TTL_SECONDS})
    # Path is the common prefix that covers both /proxy/<...> and /proxy-ws/<...>
    resp.set_cookie(
        key=f"{PROXY_COOKIE_PREFIX}{kid}",
        value=token,
        max_age=PROXY_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        path=f"/api/kuma/{kid}/",
    )
    return resp


_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
}
_DROP_RESP_HEADERS = _HOP_BY_HOP | {
    "x-frame-options", "content-security-policy", "content-security-policy-report-only",
    "content-encoding",  # httpx already decoded
}


_ATTR_RE = re.compile(
    r'((?:src|href|action|formaction|data|poster|cite|background)\s*=\s*["\'])(/(?!/)[^"\']*)',
    re.IGNORECASE,
)
_SRCSET_RE = re.compile(r'(srcset\s*=\s*["\'])([^"\']+)', re.IGNORECASE)
_CSS_URL_RE = re.compile(r'url\(\s*(["\']?)(/(?!/)[^"\')\s]+)\1?\s*\)')
_META_REFRESH_RE = re.compile(
    r'(<meta[^>]+http-equiv\s*=\s*["\']refresh["\'][^>]+content\s*=\s*["\'][^"\']*url=)(/(?!/)[^"\'>\s]+)',
    re.IGNORECASE,
)


def _rewrite_paths(text: str, prefix: str) -> str:
    """Replace absolute paths "/..." with "{prefix}/..." in known URL-bearing attributes."""
    def attr_repl(m):
        attr, path = m.group(1), m.group(2)
        if path.startswith(prefix):
            return m.group(0)
        return attr + prefix + path

    def srcset_repl(m):
        attr, value = m.group(1), m.group(2)
        # srcset is comma-separated "URL widthDescriptor" pairs
        parts = []
        for chunk in value.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            bits = chunk.split(None, 1)
            url = bits[0]
            rest = (" " + bits[1]) if len(bits) > 1 else ""
            if url.startswith("/") and not url.startswith("//") and not url.startswith(prefix):
                url = prefix + url
            parts.append(url + rest)
        return attr + ", ".join(parts)

    def css_repl(m):
        q, path = m.group(1), m.group(2)
        if path.startswith(prefix):
            return m.group(0)
        return f'url({q}{prefix}{path}{q})'

    def meta_repl(m):
        head, path = m.group(1), m.group(2)
        if path.startswith(prefix):
            return m.group(0)
        return head + prefix + path

    text = _ATTR_RE.sub(attr_repl, text)
    text = _SRCSET_RE.sub(srcset_repl, text)
    text = _CSS_URL_RE.sub(css_repl, text)
    text = _META_REFRESH_RE.sub(meta_repl, text)
    return text


def _inject_rewriter(body: bytes, kid: int, _base_path: str) -> bytes:
    """Rewrite absolute paths + inject runtime fetch/XHR/WebSocket overrides.
    Vue Router reads <base href> and uses it as the router base — we MUST set it
    to exactly our proxy prefix (without subpath), otherwise the router can't map
    pathname back to a registered route."""
    try:
        html = body.decode("utf-8", errors="replace")
    except Exception:
        return body
    prefix = f"/api/kuma/{kid}/proxy"

    # 1) Static rewrite of attribute and CSS url() paths in the served HTML
    html = _rewrite_paths(html, prefix)

    # 2) Inject runtime patches:
    #    - fetch/XHR: prepend proxy prefix to absolute paths
    #    - WebSocket: route through /proxy-ws/<path>
    #    - history.pushState/replaceState: keep URL inside proxy when SPA navigates
    #    - Location.prototype.pathname: hide proxy prefix from JS that reads it
    #      (Vue Router was built with BASE_URL baked in — it expects the original path)
    prefix_ws = f"/api/kuma/{kid}/proxy-ws"
    inject = (
        # NB: no trailing slash on purpose. Vue Router's Kb(pathname, base) does
        #   pathname.slice(base.length)
        # so with base="/api/kuma/1/proxy" and pathname="/api/kuma/1/proxy/dashboard/"
        # we get "/dashboard/" — which matches Kuma's route definitions like /dashboard.
        # Browser-level resolution of relative URLs is irrelevant: all absolute paths
        # in the served HTML are already rewritten to include the full prefix.
        f'<base href="{prefix}">\n'
        '<script>'
        '(function(){'
        f'var P="{prefix}";'
        f'var WP="{prefix_ws}";'
        'function fix(u){'
          'if(typeof u!=="string")return u;'
          'if(u.indexOf(P)===0)return u;'
          'if(u.indexOf("/")===0&&u.indexOf("//")!==0)return P+u;'
          'return u;'
        '}'
        'function strip(p){'
          'if(typeof p!=="string")return p;'
          'if(p.indexOf(P)===0){var r=p.substring(P.length);return r||"/";}'
          'return p;'
        '}'
        # fetch
        'var of=window.fetch;'
        'window.fetch=function(i,o){'
          'if(typeof i==="string")i=fix(i);'
          'else if(i&&i.url){i=new Request(fix(i.url),i)}'
          'return of.call(this,i,o)'
        '};'
        # XHR
        'var oo=XMLHttpRequest.prototype.open;'
        'XMLHttpRequest.prototype.open=function(m,u){'
          'arguments[1]=fix(u);'
          'return oo.apply(this,arguments)'
        '};'
        # WebSocket → route through /proxy-ws/{path}
        'var OW=window.WebSocket;'
        'function fixws(u){'
          'try{'
            'var l=location;'
            'var proto=(l.protocol==="https:")?"wss:":"ws:";'
            'if(typeof u!=="string")return u;'
            'if(u.indexOf("ws://")===0||u.indexOf("wss://")===0){'
              'var x=new URL(u);'
              'return proto+"//"+l.host+WP+x.pathname+x.search;'
            '}'
            'if(u.indexOf("/")===0&&u.indexOf("//")!==0){'
              'return proto+"//"+l.host+WP+u;'
            '}'
          '}catch(e){}'
          'return u;'
        '}'
        'function WSWrap(url,protocols){'
          'url=fixws(url);'
          'return protocols?new OW(url,protocols):new OW(url)'
        '}'
        'WSWrap.prototype=OW.prototype;'
        'WSWrap.CONNECTING=OW.CONNECTING;WSWrap.OPEN=OW.OPEN;'
        'WSWrap.CLOSING=OW.CLOSING;WSWrap.CLOSED=OW.CLOSED;'
        'window.WebSocket=WSWrap;'
        # history.pushState/replaceState — add prefix back when SPA navigates
        'var ops=history.pushState.bind(history);'
        'history.pushState=function(s,t,u){'
          'if(typeof u==="string"){'
            'if(u.indexOf("/")===0&&u.indexOf("//")!==0&&u.indexOf(P)!==0)u=P+u;'
          '}'
          'return ops(s,t,u)'
        '};'
        'var ors=history.replaceState.bind(history);'
        'history.replaceState=function(s,t,u){'
          'if(typeof u==="string"){'
            'if(u.indexOf("/")===0&&u.indexOf("//")!==0&&u.indexOf(P)!==0)u=P+u;'
          '}'
          'return ors(s,t,u)'
        '};'
        '})();</script>'
    )
    lower = html.lower()
    head_pos = lower.find("<head>")
    if head_pos >= 0:
        head_end = head_pos + len("<head>")
        html = html[:head_end] + "\n" + inject + html[head_end:]
    else:
        html = inject + html
    return html.encode("utf-8")


def _rewrite_css(body: bytes, kid: int) -> bytes:
    try:
        text = body.decode("utf-8", errors="replace")
    except Exception:
        return body
    prefix = f"/api/kuma/{kid}/proxy"
    text = _CSS_URL_RE.sub(
        lambda m: m.group(0) if m.group(2).startswith(prefix)
        else f'url({m.group(1)}{prefix}{m.group(2)}{m.group(1)})',
        text,
    )
    return text.encode("utf-8")


def _rewrite_redirect_location(loc: str, kid: int) -> str:
    """Make sure 3xx Location stays inside the proxy."""
    if not loc:
        return loc
    prefix = f"/api/kuma/{kid}/proxy"
    if loc.startswith(prefix):
        return loc
    if loc.startswith("/"):
        return prefix + loc
    # Absolute URL — drop scheme/host, keep path
    try:
        p = urlparse(loc)
        if p.scheme and p.netloc:
            return prefix + (p.path or "/") + (("?" + p.query) if p.query else "")
    except Exception:
        pass
    return loc


@router.api_route(
    "/{kid}/proxy/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def kuma_proxy(kid: int, path: str, request: Request, db: AsyncSession = Depends(get_db)):
    # Auth via the dedicated proxy cookie (set by /proxy-grant)
    cookie = request.cookies.get(f"{PROXY_COOKIE_PREFIX}{kid}")
    if not cookie:
        raise HTTPException(401, "Proxy not granted. Call /proxy-grant first.")
    username = _verify_proxy_token(cookie, kid)
    if not username:
        raise HTTPException(401, "Proxy token invalid or expired")

    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if not user:
        raise HTTPException(401, "User not found")

    k = await db.get(KumaInstance, kid)
    if not k or k.owner_user_id != user.id:
        raise HTTPException(404, "Not found")

    # Construct upstream URL from instance origin + remaining path
    p = urlparse(k.url)
    origin = f"{p.scheme}://{p.netloc}"
    target = f"{origin}/{path}"
    if request.url.query:
        target += "?" + request.url.query

    # Filter forwarded request headers
    fwd_headers = {}
    for h, v in request.headers.items():
        lh = h.lower()
        if lh in _HOP_BY_HOP or lh in ("host", "cookie", "authorization", "referer", "origin"):
            continue
        fwd_headers[h] = v
    # Provide upstream-friendly Host
    fwd_headers["Host"] = p.netloc

    body = await request.body() if request.method not in ("GET", "HEAD") else None

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=False) as c:
            upstream = await c.request(request.method, target, content=body, headers=fwd_headers)
    except Exception as e:
        return Response(content=f"Proxy error: {e}", status_code=502, media_type="text/plain")

    # Filter & possibly rewrite response headers
    out_headers = {}
    for hname, hval in upstream.headers.items():
        if hname.lower() in _DROP_RESP_HEADERS:
            continue
        if hname.lower() == "location":
            hval = _rewrite_redirect_location(hval, kid)
        out_headers[hname] = hval

    content = upstream.content
    ctype = upstream.headers.get("content-type", "").lower()
    # Rewrite HTML — inject <base>, runtime fetch/XHR patch + static path rewrites
    if "text/html" in ctype and content:
        dir_path = "/" + "/".join(path.split("/")[:-1])
        if not dir_path.endswith("/"):
            dir_path += "/"
        if not dir_path.startswith("/"):
            dir_path = "/" + dir_path
        content = _inject_rewriter(content, kid, dir_path)
    # Rewrite CSS — url(/...) → url(/api/kuma/{id}/proxy/...)
    elif "text/css" in ctype and content:
        content = _rewrite_css(content, kid)

    return Response(content=content, status_code=upstream.status_code, headers=out_headers, media_type=ctype or None)


# ── WebSocket proxy (for Kuma socket.io live updates) ─────────────────────

@router.websocket("/{kid}/proxy-ws/{path:path}")
async def kuma_ws_proxy(websocket: WebSocket, kid: int, path: str):
    """Bidirectional WS proxy. Auth via the same cookie as HTTP proxy."""
    cookie = websocket.cookies.get(f"{PROXY_COOKIE_PREFIX}{kid}")
    if not cookie:
        await websocket.close(code=1008)
        return
    username = _verify_proxy_token(cookie, kid)
    if not username:
        await websocket.close(code=1008)
        return

    # Look up instance and validate ownership
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if not user:
            await websocket.close(code=1008); return
        k = await db.get(KumaInstance, kid)
        if not k or k.owner_user_id != user.id:
            await websocket.close(code=1008); return
        instance_url = k.url

    # Compose upstream WebSocket URL
    p = urlparse(instance_url)
    scheme = "wss" if p.scheme == "https" else "ws"
    qs = str(websocket.url.query)
    upstream_url = f"{scheme}://{p.netloc}/{path}"
    if qs:
        upstream_url += "?" + qs

    await websocket.accept(subprotocol=websocket.headers.get("sec-websocket-protocol", "").split(",")[0].strip() or None)

    try:
        session = aiohttp.ClientSession()
        try:
            async with session.ws_connect(
                upstream_url, heartbeat=25, max_msg_size=0,
                headers={"User-Agent": "DomainManager-WS-Proxy/1.0"},
            ) as upstream:
                async def client_to_upstream():
                    try:
                        while True:
                            msg = await websocket.receive()
                            mtype = msg.get("type")
                            if mtype == "websocket.disconnect":
                                break
                            if msg.get("text") is not None:
                                await upstream.send_str(msg["text"])
                            elif msg.get("bytes") is not None:
                                await upstream.send_bytes(msg["bytes"])
                    except WebSocketDisconnect:
                        pass
                    except Exception as e:
                        logger.debug(f"[kuma-ws] c→u closed: {e}")
                    finally:
                        try: await upstream.close()
                        except Exception: pass

                async def upstream_to_client():
                    try:
                        async for msg in upstream:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                await websocket.send_text(msg.data)
                            elif msg.type == aiohttp.WSMsgType.BINARY:
                                await websocket.send_bytes(msg.data)
                            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                break
                    except Exception as e:
                        logger.debug(f"[kuma-ws] u→c closed: {e}")
                    finally:
                        try: await websocket.close()
                        except Exception: pass

                t1 = asyncio.create_task(client_to_upstream())
                t2 = asyncio.create_task(upstream_to_client())
                done, pending = await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                    try: await t
                    except Exception: pass
        finally:
            await session.close()
    except aiohttp.ClientError as e:
        logger.warning(f"[kuma-ws] upstream connect failed: {e}")
        try: await websocket.close(code=1011)
        except Exception: pass
    except Exception as e:
        logger.exception(f"[kuma-ws] unexpected: {e}")
        try: await websocket.close(code=1011)
        except Exception: pass
