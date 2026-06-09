"""Symmetric encryption helpers backed by SECRET_KEY.

Used for: KeePass owner master-password recall, IMAP passwords, anything else
we want to store on the server but not in plaintext.
"""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


def _fernet() -> Fernet:
    digest = hashlib.sha256(settings.SECRET_KEY.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(s: str) -> str:
    return _fernet().encrypt(s.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str:
    return _fernet().decrypt(token.encode("ascii")).decode("utf-8")


__all__ = ["encrypt_secret", "decrypt_secret", "InvalidToken"]
