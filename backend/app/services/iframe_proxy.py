"""Reusable HTTP/WebSocket proxy primitives for embedding third-party SPAs
inside an <iframe> on the platform's origin.

Used by Kuma proxy and Mail webmail proxy. Strips X-Frame-Options / CSP,
rewrites absolute paths in HTML/CSS to go through our prefix, injects runtime
fetch/XHR/WebSocket overrides, and bridges Location/history APIs where useful.
"""
from __future__ import annotations
import re
from urllib.parse import urlparse


# ── Constants ────────────────────────────────────────────────────────────

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
}
DROP_RESP_HEADERS = HOP_BY_HOP | {
    "x-frame-options", "content-security-policy", "content-security-policy-report-only",
    "content-encoding",
    # Strip these too — they often block iframe embedding of SPAs that use WASM
    "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
    "permissions-policy", "feature-policy",
}
DROP_REQ_HEADERS = {"host", "cookie", "authorization", "referer", "origin",
                    *HOP_BY_HOP, "content-length"}


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


# ── HTML rewriting ───────────────────────────────────────────────────────

def rewrite_paths(text: str, prefix: str) -> str:
    """Replace absolute paths '/...' with '{prefix}/...' in URL-bearing attrs + CSS url()."""
    def attr_repl(m):
        attr, path = m.group(1), m.group(2)
        if path.startswith(prefix):
            return m.group(0)
        return attr + prefix + path

    def srcset_repl(m):
        attr, value = m.group(1), m.group(2)
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


def inject_runtime_patches(body: bytes, prefix: str, ws_prefix: str) -> bytes:
    """Rewrite HTML response + inject <base> and JS that intercepts fetch / XHR /
    WebSocket / history.push|replaceState at runtime."""
    try:
        html = body.decode("utf-8", errors="replace")
    except Exception:
        return body

    html = rewrite_paths(html, prefix)

    inject = (
        # <base> without trailing slash — Vue Router and similar use Kb(pathname, base)
        # so we want pathname.slice(base.length) to keep the leading '/'.
        f'<base href="{prefix}">\n'
        '<script>'
        '(function(){'
        f'var P="{prefix}";'
        f'var WP="{ws_prefix}";'
        'function fix(u){'
          'if(typeof u!=="string")return u;'
          'if(u.indexOf(P)===0)return u;'
          'if(u.indexOf("/")===0&&u.indexOf("//")!==0)return P+u;'
          'return u;'
        '}'
        # URL constructor — tolerate empty/invalid args so Proton-style SPAs survive
        'var OURL=window.URL;'
        'function safeURL(u,b){'
          'try{'
            'if(u==null||u===undefined||u==="")u=location.href;'
            'if(typeof u==="string"){'
              'if(!b&&!(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u))){'
                # relative URL → use document base
                'b=location.href;'
              '}'
            '}'
            'return b?new OURL(u,b):new OURL(u);'
          '}catch(e){'
            # last resort — silent stub URL so consumers do not crash
            'try{return new OURL(location.origin+"/_dm_fallback")}catch(e2){return new OURL("https://invalid.local/")}'
          '}'
        '}'
        # Preserve prototype + static methods
        'safeURL.prototype=OURL.prototype;'
        'safeURL.createObjectURL=function(){return OURL.createObjectURL.apply(OURL,arguments)};'
        'safeURL.revokeObjectURL=function(){return OURL.revokeObjectURL.apply(OURL,arguments)};'
        'if(OURL.canParse)safeURL.canParse=function(){try{return OURL.canParse.apply(OURL,arguments)}catch(e){return false}};'
        'if(OURL.parse)safeURL.parse=function(){try{return OURL.parse.apply(OURL,arguments)}catch(e){return null}};'
        'try{window.URL=safeURL}catch(e){}'
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
        # WebSocket
        'var OW=window.WebSocket;'
        'function fixws(u){'
          'try{'
            'var l=location;'
            'var proto=(l.protocol==="https:")?"wss:":"ws:";'
            'if(typeof u!=="string")return u;'
            'if(u.indexOf("ws://")===0||u.indexOf("wss://")===0){'
              'var x=new OURL(u);'
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
        # history.push/replaceState — keep URLs inside the proxy when SPA navigates
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
        # ServiceWorker — Tutanota / Proton-style apps register an SW from the
        # main bundle and then await navigator.serviceWorker.ready before letting
        # the user log in. In a cross-origin iframe SW registration is restricted,
        # so the wait hangs forever.
        #
        # Strategy: return a synthetic "registered" mock object so the app's
        # await-resolves immediately. The mock has no real fetch interception
        # — but our outer fetch/XHR/WebSocket patches already route everything
        # through the proxy, so the app keeps working at the HTTP layer.
        'if(navigator.serviceWorker){'
          'var fakeReg={'
            'active:{state:"activated",scriptURL:location.href,postMessage:function(){}},'
            'installing:null,waiting:null,scope:location.origin+"/",'
            'update:function(){return Promise.resolve()},'
            'unregister:function(){return Promise.resolve(true)},'
            'addEventListener:function(){},'
            'removeEventListener:function(){},'
            'postMessage:function(){},'
          '};'
          'navigator.serviceWorker.register=function(scriptURL,options){'
            'console.warn("[dm-proxy] SW register stubbed for",scriptURL);'
            'return Promise.resolve(fakeReg);'
          '};'
          'try{'
            'navigator.serviceWorker.getRegistration=function(){return Promise.resolve(fakeReg)};'
            'navigator.serviceWorker.getRegistrations=function(){return Promise.resolve([fakeReg])};'
          '}catch(e){}'
          # navigator.serviceWorker.ready — must resolve fast with our fake
          'try{'
            'Object.defineProperty(navigator.serviceWorker,"ready",{'
              'configurable:true,'
              'get:function(){return Promise.resolve(fakeReg)}'
            '});'
          '}catch(e){console.warn("[dm-proxy] ready patch failed:",e)}'
        '}'
        # Catch top-level Errors that Proton throws when URL fails, log but do not let them crash whole page
        'window.addEventListener("error",function(ev){'
          'if(ev&&ev.message&&/Failed to construct .URL./.test(ev.message)){'
            'console.warn("[dm-proxy] Swallowed URL ctor error:",ev.message);'
            'ev.preventDefault&&ev.preventDefault();'
            'return true;'
          '}'
        '},true);'
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


def rewrite_css(body: bytes, prefix: str) -> bytes:
    try:
        text = body.decode("utf-8", errors="replace")
    except Exception:
        return body
    text = _CSS_URL_RE.sub(
        lambda m: m.group(0) if m.group(2).startswith(prefix)
        else f'url({m.group(1)}{prefix}{m.group(2)}{m.group(1)})',
        text,
    )
    return text.encode("utf-8")


def rewrite_redirect_location(loc: str, prefix: str) -> str:
    """Force 3xx Location headers to stay inside our proxy."""
    if not loc:
        return loc
    if loc.startswith(prefix):
        return loc
    if loc.startswith("/"):
        return prefix + loc
    try:
        p = urlparse(loc)
        if p.scheme and p.netloc:
            return prefix + (p.path or "/") + (("?" + p.query) if p.query else "")
    except Exception:
        pass
    return loc
