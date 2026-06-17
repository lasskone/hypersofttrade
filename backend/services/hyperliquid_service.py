"""
Hyperliquid service — placeholder

Will wrap the hyperliquid-python-sdk to provide a clean async interface
for the rest of the application.
"""
from __future__ import annotations

# from hyperliquid.info import Info
# from hyperliquid.exchange import Exchange

MAINNET_API_URL = "https://api.hyperliquid.xyz"


class HyperliquidService:
    """Thin wrapper around the Hyperliquid SDK."""

    def __init__(self, referral_code: str = "KNS"):
        self.referral_code = referral_code
        # self.info = Info(MAINNET_API_URL, skip_ws=True)

    async def get_account_info(self, address: str) -> dict:
        # return self.info.user_state(address)
        return {"address": address}

    async def get_positions(self, address: str) -> list:
        # state = self.info.user_state(address)
        # return state.get("assetPositions", [])
        return []

    async def place_order(self, payload: dict) -> dict:
        raise NotImplementedError("place_order not yet implemented")


hyperliquid_service = HyperliquidService()
