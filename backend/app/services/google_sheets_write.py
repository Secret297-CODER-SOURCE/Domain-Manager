"""Write-path Google Sheets integration via a service account.

Usage:
    1. Create a Google Cloud project + enable Sheets/Drive API.
    2. Create a Service Account, generate a JSON key.
    3. Put the JSON content as a single line into env var
       `GOOGLE_SERVICE_ACCOUNT_JSON` (or path in `GOOGLE_SERVICE_ACCOUNT_FILE`).
    4. In your Google Sheet, share with the SA email as Editor.
    5. Pass the sheet URL to `sync_to_google_sheet(...)`.

All errors raise GoogleSheetsError so callers can surface them in the UI.
"""
from __future__ import annotations
import json
import os
import re
import threading
from typing import Optional

import gspread
from google.oauth2.service_account import Credentials


SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]

# Module-level singletons. Re-create only when env vars change (rare).
_client_lock = threading.Lock()
_client: Optional[gspread.Client] = None
_client_sig: Optional[str] = None


class GoogleSheetsError(Exception):
    pass


def _load_credentials() -> Credentials:
    raw = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
    path = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE")
    if raw:
        try:
            info = json.loads(raw)
        except json.JSONDecodeError as e:
            raise GoogleSheetsError(f"GOOGLE_SERVICE_ACCOUNT_JSON invalid: {e}")
    elif path:
        try:
            with open(path) as f:
                info = json.load(f)
        except Exception as e:
            raise GoogleSheetsError(f"Cannot read {path}: {e}")
    else:
        raise GoogleSheetsError(
            "Google Sheets API не налаштовано. Задайте env "
            "GOOGLE_SERVICE_ACCOUNT_JSON або GOOGLE_SERVICE_ACCOUNT_FILE."
        )
    return Credentials.from_service_account_info(info, scopes=SCOPES)


def get_client() -> gspread.Client:
    global _client, _client_sig
    sig = (os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")[:64]
           + "|" + os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", ""))
    with _client_lock:
        if _client is None or _client_sig != sig:
            creds = _load_credentials()
            _client = gspread.authorize(creds)
            _client_sig = sig
        return _client


_URL_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")


def extract_sheet_id(url: str) -> str:
    m = _URL_ID_RE.search(url or "")
    if not m:
        raise GoogleSheetsError("Невалідний Google Sheet URL")
    return m.group(1)


def is_configured() -> bool:
    return bool(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON") or os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE"))


def get_service_account_email() -> Optional[str]:
    """Returns the SA's email (`client_email`) — what the user has to share
    the sheet with. None when not configured / unreadable."""
    raw = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
    path = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE")
    try:
        if raw:
            info = json.loads(raw)
        elif path:
            with open(path) as f:
                info = json.load(f)
        else:
            return None
        return info.get("client_email")
    except Exception:
        return None


def sync_to_google_sheet(url: str, headers: list[str], rows: list[list]) -> dict:
    """Replace the contents of the first worksheet of `url` with given rows.

    Returns {"updated": N, "tab": title}. Caller catches GoogleSheetsError.
    """
    client = get_client()
    sheet_id = extract_sheet_id(url)
    try:
        ss = client.open_by_key(sheet_id)
    except gspread.exceptions.APIError as e:
        msg = str(e)
        if "403" in msg or "PERMISSION_DENIED" in msg:
            email = get_service_account_email() or "невідомо"
            raise GoogleSheetsError(
                f"SA не має доступу до таблиці. Поділіться нею з: {email}"
            )
        raise GoogleSheetsError(f"Google API: {msg}")
    except Exception as e:
        raise GoogleSheetsError(f"Помилка відкриття: {e}")

    ws = ss.sheet1
    # Build matrix: header + rows
    matrix = [list(headers)] + [[("" if v is None else str(v)) for v in r] for r in rows]
    try:
        ws.clear()
        ws.update("A1", matrix, value_input_option="RAW")
    except Exception as e:
        raise GoogleSheetsError(f"Запис не вдався: {e}")
    return {"updated": len(rows), "tab": ws.title}
