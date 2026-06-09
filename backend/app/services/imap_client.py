"""Small synchronous IMAP helper, called from async routes via asyncio.to_thread().
Returns plain dicts ready for JSON serialization.
"""
from __future__ import annotations
import email
import email.header
import email.utils
import imaplib
import re
from datetime import datetime
from email.message import Message
from typing import Optional


def _decode_header(raw) -> str:
    if not raw:
        return ""
    try:
        parts = email.header.decode_header(raw)
        out = []
        for chunk, enc in parts:
            if isinstance(chunk, bytes):
                try:
                    out.append(chunk.decode(enc or "utf-8", errors="replace"))
                except LookupError:
                    out.append(chunk.decode("utf-8", errors="replace"))
            else:
                out.append(chunk)
        return "".join(out).strip()
    except Exception:
        return str(raw)


def _parse_date(raw) -> Optional[str]:
    if not raw:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(raw)
        return dt.isoformat()
    except Exception:
        return str(raw)


def _connect(host: str, port: int, ssl: bool, username: str, password: str) -> imaplib.IMAP4:
    cls = imaplib.IMAP4_SSL if ssl else imaplib.IMAP4
    conn = cls(host, port, timeout=20)
    conn.login(username, password)
    return conn


def check_account(host: str, port: int, ssl: bool, username: str, password: str) -> dict:
    """Return {unread, total} for INBOX. Raises on auth failure."""
    conn = _connect(host, port, ssl, username, password)
    try:
        typ, _ = conn.select("INBOX", readonly=True)
        if typ != "OK":
            raise RuntimeError("Cannot SELECT INBOX")
        typ, data = conn.search(None, "ALL")
        total = len(data[0].split()) if data and data[0] else 0
        typ, data = conn.search(None, "UNSEEN")
        unread = len(data[0].split()) if data and data[0] else 0
        return {"unread": unread, "total": total}
    finally:
        try: conn.logout()
        except Exception: pass


def list_messages(host: str, port: int, ssl: bool, username: str, password: str, limit: int = 50) -> list[dict]:
    """Return the most recent `limit` messages from INBOX, newest first."""
    conn = _connect(host, port, ssl, username, password)
    try:
        typ, _ = conn.select("INBOX", readonly=True)
        if typ != "OK":
            raise RuntimeError("Cannot SELECT INBOX")
        typ, data = conn.uid("search", None, "ALL")
        if typ != "OK" or not data or not data[0]:
            return []
        uids = data[0].split()
        recent = uids[-limit:] if len(uids) > limit else uids
        recent.reverse()  # newest first
        if not recent:
            return []
        uid_set = b",".join(recent)
        typ, fetched = conn.uid(
            "fetch", uid_set.decode(),
            "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])"
        )
        if typ != "OK":
            return []
        out: list[dict] = []
        # IMAP fetch returns interleaved tuples + bytes; pair them up
        for item in fetched:
            if not isinstance(item, tuple) or len(item) < 2:
                continue
            meta_bytes, header_bytes = item[0], item[1]
            meta = meta_bytes.decode("utf-8", errors="replace") if isinstance(meta_bytes, (bytes, bytearray)) else str(meta_bytes)
            uid_m = re.search(r"UID (\d+)", meta)
            uid = uid_m.group(1) if uid_m else None
            flags_m = re.search(r"FLAGS \(([^)]*)\)", meta)
            flags = flags_m.group(1).split() if flags_m else []
            unread = "\\Seen" not in flags
            try:
                msg = email.message_from_bytes(header_bytes)
            except Exception:
                continue
            out.append({
                "uid": uid,
                "unread": unread,
                "subject": _decode_header(msg.get("Subject")),
                "from": _decode_header(msg.get("From")),
                "to": _decode_header(msg.get("To")),
                "date": _parse_date(msg.get("Date")),
            })
        return out
    finally:
        try: conn.logout()
        except Exception: pass


def _extract_body(msg: Message) -> dict:
    """Return {text, html} where html may be None."""
    text_body = None
    html_body = None
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = (part.get("Content-Disposition") or "").lower()
            if "attachment" in disp:
                continue
            if ctype == "text/plain" and text_body is None:
                try:
                    text_body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
                except Exception:
                    pass
            elif ctype == "text/html" and html_body is None:
                try:
                    html_body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
                except Exception:
                    pass
    else:
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                decoded = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")
                if msg.get_content_type() == "text/html":
                    html_body = decoded
                else:
                    text_body = decoded
        except Exception:
            pass
    return {"text": text_body, "html": html_body}


def fetch_message(host: str, port: int, ssl: bool, username: str, password: str, uid: str) -> Optional[dict]:
    conn = _connect(host, port, ssl, username, password)
    try:
        typ, _ = conn.select("INBOX", readonly=True)
        if typ != "OK":
            return None
        typ, data = conn.uid("fetch", uid, "(BODY.PEEK[])")
        if typ != "OK" or not data or not data[0]:
            return None
        # data[0] is a tuple (b'1 (UID ... BODY[] {N}', b'<raw rfc822>') possibly followed by b')'
        raw = None
        for item in data:
            if isinstance(item, tuple) and len(item) >= 2:
                raw = item[1]
                break
        if not raw:
            return None
        msg = email.message_from_bytes(raw)
        body = _extract_body(msg)
        attachments = []
        if msg.is_multipart():
            for part in msg.walk():
                disp = (part.get("Content-Disposition") or "").lower()
                if "attachment" not in disp:
                    continue
                fn = _decode_header(part.get_filename())
                attachments.append({
                    "filename": fn or "attachment",
                    "size": len(part.get_payload(decode=True) or b""),
                    "content_type": part.get_content_type(),
                })
        return {
            "uid": uid,
            "subject": _decode_header(msg.get("Subject")),
            "from": _decode_header(msg.get("From")),
            "to": _decode_header(msg.get("To")),
            "cc": _decode_header(msg.get("Cc")),
            "date": _parse_date(msg.get("Date")),
            "text": body["text"],
            "html": body["html"],
            "attachments": attachments,
        }
    finally:
        try: conn.logout()
        except Exception: pass
