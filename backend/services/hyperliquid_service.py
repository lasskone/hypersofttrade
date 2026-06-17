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
    # Market data
    # ------------------------------------------------------------------

    async def get_all_mids(self) -> dict:
        """Return a dict of symbol -> mid price for all assets."""
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(INFO_ENDPOINT, json={"type": "allMids"})
            resp.raise_for_status()
        return resp.json()

    async def get_orderbook(self, symbol: str) -> dict:
        """Return top-of-book bids and asks for *symbol*."""
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                INFO_ENDPOINT, json={"type": "l2Book", "coin": symbol}
            )
            resp.raise_for_status()
        data = resp.json()
        # l2Book returns {"levels": [[bids], [asks]]}
        levels = data.get("levels", [[], []])
        bids = levels[0] if len(levels) > 0 else []
        asks = levels[1] if len(levels) > 1 else []
        return {"bids": bids, "asks": asks}

    async def get_user_positions(self, wallet_address: str) -> dict:
        """Return full clearinghouse state for *wallet_address*."""
        return await self.get_user_state(wallet_address)

    # ------------------------------------------------------------------
    # Account
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
        """Return True if *wallet_address* is referred by *referral_code*."""
        wallet = wallet_address.lower()
        payload = {"type": "referral", "user": wallet}
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(INFO_ENDPOINT, json=payload)
            resp.raise_for_status()

        data = resp.json()
        print(f"[affiliation] wallet={wallet} response={data}")

        try:
            # Primary structure: data["referredBy"]["code"]
            code = (data.get("referredBy") or {}).get("code", "")
            if not code:
                # Fallback structure: data["referrer"]["code"]
                code = (data.get("referrer") or {}).get("code", "")
            is_affiliated = code.upper() == referral_code.upper()
        except (KeyError, TypeError, AttributeError):
            is_affiliated = False

        print(f"[affiliation] result={is_affiliated}")
        return is_affiliated

    # ------------------------------------------------------------------
    # Legacy stubs
    # ------------------------------------------------------------------

    async def get_account_info(self, address: str) -> dict:
        return await self.get_user_state(address)

    async def get_positions(self, address: str) -> list:
        state = await self.get_user_state(address)
        return state.get("assetPositions", [])

    async def place_order(self, payload: dict) -> dict:
        raise NotImplementedError("place_order not yet implemented")


hyperliquid_service = HyperliquidService()
