import secrets
from datetime import datetime, timedelta, timezone

# {username: {'otp': str, 'expires': datetime}}
_otp_store: dict = {}

# {token: {'username': str, 'expires': datetime}}
_token_store: dict = {}


def generate_otp(username: str) -> str:
    code = f"{secrets.randbelow(1000000):06d}"
    _otp_store[username] = {
        "otp": code,
        "expires": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    return code


def verify_otp_and_issue_token(username: str, code: str) -> str | None:
    entry = _otp_store.get(username)
    if not entry:
        return None
    if datetime.now(timezone.utc) > entry["expires"]:
        _otp_store.pop(username, None)
        return None
    if entry["otp"] != code.strip().replace(" ", ""):
        return None
    _otp_store.pop(username, None)

    token = secrets.token_urlsafe(32)
    _token_store[token] = {
        "username": username,
        "expires": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    return token


def verify_delete_token(token: str, username: str) -> bool:
    entry = _token_store.get(token)
    if not entry:
        return False
    if entry["username"] != username:
        return False
    if datetime.now(timezone.utc) > entry["expires"]:
        _token_store.pop(token, None)
        return False
    return True
