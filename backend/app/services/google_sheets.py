"""Public Google Sheets ingest via CSV export (no auth required).

The spreadsheet must be shared "Anyone with the link → Viewer".

Tab discovery uses the `gviz` JSONP endpoint which lists every sheet
(name + gid) without needing OAuth. Per-tab data is then fetched via
the standard `export?format=csv&gid=<gid>` URL.
"""
from __future__ import annotations

import csv
import io
import json
import re
from typing import List, Dict, Any, Optional

import httpx


SHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")


def extract_sheet_id(url: str) -> str:
    m = SHEET_ID_RE.search(url or "")
    if not m:
        raise ValueError("Не схоже на посилання Google Sheets")
    return m.group(1)


def _decode_js_string(s: str) -> str:
    """Decode a JS-escaped string fragment ('\\/', '\\x20', '\\u0041', etc.)."""
    try:
        # JSON decoder handles \uXXXX and most escapes; wrap as JSON string
        return json.loads('"' + s.replace('\\/', '/') + '"')
    except Exception:
        try:
            return s.encode().decode('unicode_escape')
        except Exception:
            return s


async def discover_tabs(url: str) -> Dict[str, Any]:
    """Return {sheet_id, title, tabs:[{gid, name, index}]}.

    Strategy (most-to-least reliable):
      1. /htmlview — public "static-render" endpoint. Embeds an `items.push({
         name:..., gid:...})` per tab in inline JS. Works for any sheet shared
         "Anyone with link". Survived all Google UI refactors so far.
      2. /pubhtml — published-to-web variant; sometimes works when /htmlview
         is restricted.
      3. /edit HTML scrape — fragile but kept as last resort.
      4. Single Sheet1 (gid=0) — at least the user can import the default tab.
    """
    sid = extract_sheet_id(url)
    title = ""
    tabs: List[Dict[str, Any]] = []

    async def fetch(u: str) -> tuple[int, str]:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                     headers={"User-Agent": "Mozilla/5.0 DomainManager/1.0"}) as c:
            r = await c.get(u)
            return r.status_code, r.text

    # ── 1. /htmlview — items.push({name, gid})  ────────────────────────
    try:
        status, html = await fetch(f"https://docs.google.com/spreadsheets/d/{sid}/htmlview")
        if status == 200 and html:
            # Pull title
            tm = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
            if tm:
                title = re.sub(r"\s*-\s*Google\s*Sheets\s*$", "", tm.group(1).strip())
            # Match each items.push({name:"...", ..., gid: "..."})
            for m in re.finditer(
                r'items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\-?\d+)"',
                html,
            ):
                name = _decode_js_string(m.group(1))
                gid = m.group(2)
                if not any(t["gid"] == gid for t in tabs):
                    tabs.append({"gid": gid, "name": name})
    except Exception:
        pass

    # ── 2. /pubhtml — published variant ───────────────────────────────
    if not tabs:
        try:
            status, html = await fetch(f"https://docs.google.com/spreadsheets/d/{sid}/pubhtml")
            if status == 200 and html:
                if not title:
                    tm = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
                    if tm:
                        title = re.sub(r"\s*-\s*Google\s*Sheets\s*$", "", tm.group(1).strip())
                for m in re.finditer(
                    r'sheetMenuButton[^>]*?id="sheet-button-(\-?\d+)"[^>]*?>(?:<a[^>]*>)?\s*([^<]+?)\s*<',
                    html,
                ):
                    gid = m.group(1)
                    name = m.group(2).strip()
                    if name and not any(t["gid"] == gid for t in tabs):
                        tabs.append({"gid": gid, "name": name})
        except Exception:
            pass

    # ── 3. /edit HTML scrape (legacy fallback) ────────────────────────
    if not tabs:
        try:
            status, html = await fetch(f"https://docs.google.com/spreadsheets/d/{sid}/edit")
            if status == 200 and html:
                if not title:
                    tm = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
                    if tm:
                        title = re.sub(r"\s*-\s*Google\s*Sheets\s*$", "", tm.group(1).strip())
                for m in re.finditer(
                    r'"name":"((?:[^"\\]|\\.)*)","id":(\d+)\b',
                    html,
                ):
                    name = _decode_js_string(m.group(1))
                    gid = m.group(2)
                    if not any(t["gid"] == gid for t in tabs):
                        tabs.append({"gid": gid, "name": name})
        except Exception:
            pass

    # ── 4. Last-resort: at least Sheet1 ───────────────────────────────
    if not tabs:
        tabs = [{"gid": "0", "name": "Sheet1"}]

    for i, t in enumerate(tabs):
        t["index"] = i

    return {"sheet_id": sid, "title": title, "tabs": tabs}


async def fetch_tab_csv(sheet_id: str, gid: str) -> str:
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        r = await client.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"CSV-експорт повернув {r.status_code} — таблиця має бути 'Anyone with link'")
        # Google sometimes returns latin-1 for CSV; force utf-8 with replace.
        return r.content.decode("utf-8", errors="replace")


# Inline value-shape patterns (mirror of sheet_import.classify_value — kept
# private here to avoid a circular import).
_EMAIL_VRE  = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
_IPV4_VRE   = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$")
_URL_VRE    = re.compile(r"^https?://\S+$", re.I)
_DOMAIN_VRE = re.compile(r"^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", re.I)


def _looks_like_data(cell: str) -> bool:
    """True if cell looks like a real data value (not a column label).
    Matches: email, IPv4, URL, domain, OR password-like strings (length >= 10,
    mixing letter+digit OR containing special characters)."""
    s = (cell or "").strip()
    if not s: return False
    if _EMAIL_VRE.match(s) or _IPV4_VRE.match(s) or _URL_VRE.match(s):
        return True
    if _DOMAIN_VRE.match(s) and not s[0].isdigit() and "." in s:
        return True
    # Password-like: long enough, no spaces, mixed character classes.
    if 10 <= len(s) <= 80 and " " not in s:
        has_letter = any(c.isalpha() for c in s)
        has_digit  = any(c.isdigit() for c in s)
        has_other  = any(not c.isalnum() for c in s)
        if (has_letter and has_digit) or has_other:
            return True
    return False


def parse_csv(text: str) -> Dict[str, Any]:
    """Parse CSV into headers + rows.

    Heuristic header detection: if the first non-empty row already contains
    real data values (>=2 cells matching email/ip/url/domain shape), we treat
    the sheet as **headerless** and synthesize column names col1/col2/...

    Returns also {headerless: bool} so callers can surface this.
    """
    reader = csv.reader(io.StringIO(text))
    grid = [row for row in reader]
    if not grid:
        return {"headers": [], "rows": [], "total_rows": 0, "headerless": False}
    # Pick the first non-empty row as candidate header. Real-world sheets
    # sometimes have a blank row above.
    header_idx = 0
    for i, row in enumerate(grid):
        if any(cell.strip() for cell in row):
            header_idx = i; break

    candidate = grid[header_idx]
    data_cells = sum(1 for c in candidate if _looks_like_data(c))
    headerless = data_cells >= 2

    if headerless:
        # No header row — generate generic names and treat every non-empty row as data
        max_cols = max((len(r) for r in grid[header_idx:]), default=0)
        headers = [f"col{j+1}" for j in range(max_cols)]
        body = grid[header_idx:]
    else:
        headers_raw = candidate
        # Deduplicate / number empty headers so we have stable keys.
        headers = []
        seen: Dict[str, int] = {}
        for j, h in enumerate(headers_raw):
            h = (h or "").strip() or f"col{j+1}"
            if h in seen:
                seen[h] += 1
                h = f"{h}_{seen[h]}"
            else:
                seen[h] = 1
            headers.append(h)
        body = grid[header_idx + 1:]

    rows: List[Dict[str, str]] = []
    for row in body:
        if not any(cell.strip() for cell in row):
            continue
        d = {headers[i]: (row[i].strip() if i < len(row) else "") for i in range(len(headers))}
        rows.append(d)
    return {"headers": headers, "rows": rows, "total_rows": len(rows), "headerless": headerless}


async def fetch_tab(sheet_id: str, gid: str) -> Dict[str, Any]:
    csv_text = await fetch_tab_csv(sheet_id, gid)
    return parse_csv(csv_text)
