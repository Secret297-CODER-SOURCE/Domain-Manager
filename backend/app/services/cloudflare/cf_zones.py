"""
cf_zones.py — базові запити до Cloudflare API.
Автоматично визначає тип ключа:
  - cfk_... або довжина != 37  →  API Token (Bearer)
  - інакше                      →  Global API Key (X-Auth-Email + X-Auth-Key)
"""
import httpx
from typing import Optional

CF_API = "https://api.cloudflare.com/client/v4"
TIMEOUT = 30


class CFAuthError(Exception):
    """Cloudflare rejected the credentials outright (401/403) — the token is
    actually invalid/revoked. Distinct from transient failures (rate limits,
    timeouts, 5xx) so callers can tell "this account is dead" apart from
    "try again later" instead of treating every hiccup as a dead token."""
    pass


def detect_auth_type(api_key: str) -> str:
    """Returns 'token' or 'global'"""
    # cfk_ keys use X-Auth-Key + X-Auth-Email (NOT Bearer)
    if api_key.startswith("cfk_"):
        return "global"
    # v1.0- is a Bearer API token
    if api_key.startswith("v1.0-"):
        return "token"
    # Standard Global API keys are exactly 37 hex chars
    if len(api_key) == 37 and all(c in "0123456789abcdefABCDEF" for c in api_key):
        return "global"
    # Default to Bearer token for everything else
    return "token"


def make_headers(email: Optional[str], api_key: str) -> dict:
    auth_type = detect_auth_type(api_key)
    if auth_type == "token":
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
    else:
        return {
            "X-Auth-Email": email or "",
            "X-Auth-Key": api_key,
            "Content-Type": "application/json",
        }


async def verify_account(email: Optional[str], api_key: str) -> tuple[bool, str]:
    """
    Verify CF credentials. Returns (is_valid, account_id_or_error).
    Supports: API Tokens (Bearer, including cfk_/v1.0- prefixes) and Global API Keys.
    Tries multiple endpoints so zone-scoped tokens also work.
    """
    headers = make_headers(email, api_key)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            # 1. Try token verify (works for most API tokens)
            r = await client.get(f"{CF_API}/user/tokens/verify", headers=headers)
            if r.status_code == 200 and r.json().get("success"):
                # Token valid — try to resolve real account_id
                r2 = await client.get(f"{CF_API}/accounts?per_page=1", headers=headers)
                if r2.status_code == 200 and r2.json().get("success"):
                    accounts = r2.json().get("result", [])
                    return True, accounts[0]["id"] if accounts else "token"
                return True, "token"

            # 2. Try accounts endpoint (works for Global API Keys + some tokens)
            r2 = await client.get(f"{CF_API}/accounts?per_page=1", headers=headers)
            if r2.status_code == 200 and r2.json().get("success"):
                accounts = r2.json().get("result", [])
                acc_id = accounts[0]["id"] if accounts else ""
                return True, acc_id

            # 3. Last resort: zone-scoped tokens that only have Zones:Read permission
            r3 = await client.get(f"{CF_API}/zones?per_page=1", headers=headers)
            if r3.status_code == 200 and r3.json().get("success"):
                return True, "token"

            return False, str(r.json().get("errors", "Unknown error"))
    except Exception as e:
        return False, str(e)


async def fetch_zones(email: Optional[str], api_key: str) -> list[dict]:
    """Fetch all zones from a CF account."""
    headers = make_headers(email, api_key)
    zones = []
    page = 1
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        while True:
            r = await client.get(
                f"{CF_API}/zones",
                headers=headers,
                params={"page": page, "per_page": 50},
            )
            data = r.json()
            if not data.get("success"):
                if r.status_code in (401, 403):
                    raise CFAuthError(f"CF auth error ({r.status_code}): {data.get('errors')}")
                raise Exception(f"CF API error ({r.status_code}): {data.get('errors')}")
            zones.extend(data.get("result", []))
            info = data.get("result_info", {})
            if page >= info.get("total_pages", 1):
                break
            page += 1
    return zones


async def fetch_dns_records(email: Optional[str], api_key: str, zone_id: str) -> list[dict]:
    headers = make_headers(email, api_key)
    records = []
    page = 1
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        while True:
            r = await client.get(
                f"{CF_API}/zones/{zone_id}/dns_records",
                headers=headers,
                params={"page": page, "per_page": 100},
            )
            data = r.json()
            records.extend(data.get("result", []))
            info = data.get("result_info", {})
            if page >= info.get("total_pages", 1):
                break
            page += 1
    return records


async def get_zone_status(email: Optional[str], api_key: str, zone_id: str) -> str:
    headers = make_headers(email, api_key)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{CF_API}/zones/{zone_id}", headers=headers)
        if r.status_code == 200 and r.json().get("success"):
            return r.json()["result"].get("status", "unknown")
    return "unknown"


async def create_zone(email: Optional[str], api_key: str, domain_name: str, account_id: Optional[str] = None) -> dict:
    """Create a new zone in Cloudflare."""
    headers = make_headers(email, api_key)
    payload: dict = {"name": domain_name, "jump_start": True}
    if account_id and account_id not in ("token", ""):
        payload["account"] = {"id": account_id}
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{CF_API}/zones", headers=headers, json=payload)
        return r.json()


async def delete_zone(email: Optional[str], api_key: str, zone_id: str) -> bool:
    """Fully delete a zone from Cloudflare."""
    headers = make_headers(email, api_key)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.delete(f"{CF_API}/zones/{zone_id}", headers=headers)
        return r.status_code in (200, 204)


async def set_ssl_mode(email: Optional[str], api_key: str, zone_id: str, mode: str = "flexible") -> bool:
    """Set SSL mode for a zone (flexible / full / strict / off)."""
    headers = make_headers(email, api_key)
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.patch(
            f"{CF_API}/zones/{zone_id}/settings/ssl",
            headers=headers,
            json={"value": mode},
        )
        return r.status_code == 200 and r.json().get("success", False)
