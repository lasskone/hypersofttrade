"""
Hyperliquid service — async HTTP wrapper around the Hyperliquid public REST API.
"""
from __future__ import annotations

import httpx
from fastapi import HTTPException

MAINNET_API_URL = "https://api.hyperliquid.xyz"
INFO_ENDPOINT = f"{MAINNET_API_URL}/info"


class HyperliquidService:
    """Thin async wrapper around the Hyperliquid public API."""

    def __init__(self, referral_code: str = "KNS"):
        self.referral_code = referral_code

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    async def get_user_state(self, wallet_address: str) -> dict:
        """Return the clearinghouse state for *wallet_address*.

        Raises HTTPException(404) if the address is unknown to Hyperliquid.
        """
        payload = {"type": "clearinghouseState", "user": wallet_address}
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(INFO_ENDPOINT, json=payload)
            resp.raise_for_status()

        data = resp.json()
        if not data:
            raise HTTPException(status_code=404, detail="Wallet address not found on Hyperliquid")
        return data

    async def check_affiliation(self, wallet_address: str, referral_code: str) -> bool:
        """Return True if *wallet_address* is referred by *referral_code* on Hyperliquid."""
        payload = {"type": "referral", "user": wallet_address}
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(INFO_ENDPOINT, json=payload)
            resp.raise_for_status()

        data = resp.json()
        # The referral endpoint returns {"referredBy": {"code": "KNS", ...}, ...}
        # when the user signed up through a referral link.
        referred_by = data.get("referredBy") or {}
        code = referred_by.get("code", "")
        return code.upper() == referral_code.upper()

    # ------------------------------------------------------------------
    # Legacy stubs (kept for existing routers)
    # ------------------------------------------------------------------

    async def get_account_info(self, address: str) -> dict:
        return await self.get_user_state(address)

    async def get_positions(self, address: str) -> list:
        state = await self.get_user_state(address)
        return state.get("assetPositions", [])

    async def place_order(self, payload: dict) -> dict:
        raise NotImplementedError("place_order not yet implemented")


hyperliquid_service = HyperliquidService()
