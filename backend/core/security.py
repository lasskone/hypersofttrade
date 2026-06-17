"""
Security utilities — placeholder

Will handle:
- Fernet symmetric encryption for private keys stored in Supabase
- JWT verification for authenticated API routes
"""
from __future__ import annotations

from cryptography.fernet import Fernet

from core.config import settings


def get_fernet() -> Fernet:
    """Return a Fernet instance using the ENCRYPTION_KEY env var."""
    key = settings.encryption_key
    if not key:
        raise RuntimeError("ENCRYPTION_KEY environment variable is not set.")
    return Fernet(key.encode())


def encrypt(plaintext: str) -> str:
    f = get_fernet()
    return f.encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    f = get_fernet()
    return f.decrypt(token.encode()).decode()
