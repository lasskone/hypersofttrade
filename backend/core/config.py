from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_key: str = os.getenv("SUPABASE_KEY", "")
    encryption_key: str = os.getenv("ENCRYPTION_KEY", "")
    hyperliquid_referral: str = os.getenv("HYPERLIQUID_REFERRAL", "KNS")
    frontend_url: str = os.getenv("FRONTEND_URL", "http://localhost:3000")

    @property
    def cors_origins(self) -> list[str]:
        origins = [self.frontend_url, "http://localhost:3000"]
        extra = os.getenv("EXTRA_CORS_ORIGINS", "")
        if extra:
            origins += [o.strip() for o in extra.split(",") if o.strip()]
        return origins


settings = Settings()
