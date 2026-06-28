from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_key: str = os.getenv("SUPABASE_KEY", "")
    encryption_key: str = os.getenv("ENCRYPTION_KEY", "")
    hyperliquid_referral: str = os.getenv("HYPERLIQUID_REFERRAL", "KNS")
    # Master wallet that owns the KNS referral code — used to fetch the full
    # referral list so users who already had HL accounts can still be verified.
    hyperliquid_master_address: str = os.getenv(
        "HYPERLIQUID_MASTER_ADDRESS",
        "0x1b981579a2B194018d08bAdffd38Ac23b5DfB763",
    )
    frontend_url: str = os.getenv("FRONTEND_URL", "http://localhost:3000")

    @property
    def cors_origins(self) -> list[str]:
        origins = [self.frontend_url, "http://localhost:3000"]
        extra = os.getenv("EXTRA_CORS_ORIGINS", "")
        if extra:
            origins += [o.strip() for o in extra.split(",") if o.strip()]
        return origins


settings = Settings()
