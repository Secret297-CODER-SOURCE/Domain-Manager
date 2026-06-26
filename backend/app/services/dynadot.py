"""Minimal Dynadot REST client.

Dynadot exposes a single endpoint that returns JSON when called with
`?command=...&key=...`. We only need two operations here:
  - `ping`     → verify the key is valid
  - `list_domain` → list all domains under the account
"""
from __future__ import annotations
from typing import Any, Optional
import httpx

DYNADOT_API = "https://api.dynadot.com/api3.json"


class DynadotError(Exception):
    pass


async def _call(api_key: str, command: str, **params: Any) -> dict:
    q = {"key": api_key, "command": command, **params}
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(DYNADOT_API, params=q)
    try:
        data = r.json()
    except Exception:
        raise DynadotError(f"Non-JSON response (status {r.status_code})")
    return data


async def verify_key(api_key: str) -> tuple[bool, Optional[str]]:
    """Return (ok, error_message). Uses list_domain with a tiny payload as a ping —
    Dynadot has no dedicated ping; an invalid key returns a JSON error."""
    try:
        data = await _call(api_key, "list_domain")
    except Exception as e:
        return False, str(e)[:200]
    # Dynadot's JSON3 envelope:
    # success → {"ListDomainInfoResponse": {"ResponseCode":"0", "DomainInfoList":[...]}}
    # error   → {"Response": {"ResponseCode":"-1", "Error":"..."}}
    if "Response" in data and str(data["Response"].get("ResponseCode")) != "0":
        return False, str(data["Response"].get("Error") or "Dynadot rejected key")[:200]
    if any(k.endswith("Response") for k in data):
        return True, None
    return False, "Unexpected Dynadot response"


def _extract_domain_list(payload: dict) -> list[dict]:
    """Dig domain rows out of the Dynadot envelope (defensive against shape variance)."""
    resp = payload.get("ListDomainInfoResponse") or {}
    info = resp.get("MainDomains") or resp.get("DomainInfoList") or []
    if isinstance(info, dict):
        info = info.get("DomainInfo") or info.get("Domain") or []
    if isinstance(info, list):
        return [d for d in info if isinstance(d, dict)]
    return []


async def list_domains(api_key: str) -> list[dict]:
    data = await _call(api_key, "list_domain")
    if "Response" in data and str(data["Response"].get("ResponseCode")) != "0":
        raise DynadotError(str(data["Response"].get("Error") or "Dynadot error"))
    return _extract_domain_list(data)
