"""
Hyperliquid service — async HTTP wrapper around the Hyperliquid public REST API.
"""
from __future__ import annotations

import asyncio

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
        levels = data.get("levels", [[], []])
        bids = levels[0] if len(levels) > 0 else []
        asks = levels[1] if len(levels) > 1 else []
        return {"bids": bids, "asks": asks}

    # ------------------------------------------------------------------
    # Per-DEX account queries
    # ------------------------------------------------------------------

    async def get_all_perp_dexes(self) -> list[str]:
        """Return all perp DEX identifiers: '' for main, name string for HIP-3."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "perpDexs"},
                headers={"Content-Type": "application/json"},
            )
            dexes = response.json()
        dex_names: list[str] = []
        for dex in dexes:
            if dex is None:
                dex_names.append("")        # empty string = main dex
            elif isinstance(dex, dict) and "name" in dex:
                dex_names.append(dex["name"])
        return dex_names

    async def get_clearinghouse_state(self, wallet_address: str, dex: str = "") -> dict:
        """Return clearinghouse state for a specific DEX ('' = main)."""
        payload: dict = {"type": "clearinghouseState", "user": wallet_address}
        if dex:
            payload["dex"] = dex
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            return response.json()

    async def get_spot_state(self, wallet_address: str) -> dict:
        """Return spot balances for *wallet_address*."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "spotClearinghouseState", "user": wallet_address},
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            return response.json()

    async def get_user_fills(self, wallet_address: str) -> list:
        """Return full trade history for *wallet_address*."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "userFills", "user": wallet_address},
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            return response.json()

    async def get_open_orders(self, wallet_address: str) -> list:
        """Return all open orders for *wallet_address*."""
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                INFO_ENDPOINT,
                json={"type": "openOrders", "user": wallet_address},
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            return response.json()

    # ------------------------------------------------------------------
    # Complete portfolio aggregation
    # ------------------------------------------------------------------

    async def get_complete_portfolio(self, wallet_address: str) -> dict:
        """Aggregate portfolio across ALL DEXes (main + HIP-3), spot, fills, orders."""
        # Step 1: discover all DEX names
        dex_names = await self.get_all_perp_dexes()
        print(f"[portfolio] Found {len(dex_names)} DEXes: {dex_names}")

        # Step 2: fan-out — all DEX states + spot + fills + orders in parallel
        tasks = [self.get_clearinghouse_state(wallet_address, dex) for dex in dex_names]
        tasks.append(self.get_spot_state(wallet_address))
        tasks.append(self.get_user_fills(wallet_address))
        tasks.append(self.get_open_orders(wallet_address))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        perp_states = results[:len(dex_names)]
        spot_state  = results[len(dex_names)]
        fills       = results[len(dex_names) + 1]
        open_orders = results[len(dex_names) + 2]

        # Step 3: aggregate perp positions across all DEXes
        total_account_value  = 0.0
        total_unrealized_pnl = 0.0
        all_positions: list[dict] = []

        for i, state in enumerate(perp_states):
            if isinstance(state, Exception):
                print(f"[portfolio] DEX {dex_names[i]!r} error: {state}")
                continue

            dex_label = dex_names[i] or "main"
            margin    = state.get("marginSummary", {})
            acct_val  = float(margin.get("accountValue", "0") or "0")
            total_account_value += acct_val
            print(f"[portfolio] DEX={dex_label} accountValue={acct_val}")

            for ap in state.get("assetPositions", []):
                pos = ap.get("position", {})
                szi = float(pos.get("szi", "0") or "0")
                if szi == 0.0:
                    continue
                upnl = float(pos.get("unrealizedPnl", "0") or "0")
                total_unrealized_pnl += upnl
                all_positions.append({
                    "dex":              dex_label,
                    "symbol":           pos.get("coin", ""),
                    "size":             szi,
                    "entry_price":      float(pos.get("entryPx", "0") or "0"),
                    "position_value":   float(pos.get("positionValue", "0") or "0"),
                    "unrealized_pnl":   upnl,
                    "leverage":         (pos.get("leverage") or {}).get("value", 1),
                    "leverage_type":    (pos.get("leverage") or {}).get("type", "cross"),
                    "liquidation_price": float(pos.get("liquidationPx", "0") or "0"),
                    "margin_used":      float(pos.get("marginUsed", "0") or "0"),
                })

        # Step 4: spot balances (also add USDC spot to account value)
        spot_balances: list[dict] = []
        if not isinstance(spot_state, Exception):
            for balance in spot_state.get("balances", []):
                amount = float(balance.get("total", "0") or "0")
                if amount > 0:
                    spot_balances.append({
                        "coin":  balance.get("coin", ""),
                        "total": amount,
                        "hold":  float(balance.get("hold", "0") or "0"),
                    })
                    if balance.get("coin") == "USDC":
                        total_account_value += amount
                        print(f"[portfolio] USDC spot balance added: {amount}")

        # Step 5: recent fills (last 50)
        recent_fills: list[dict] = []
        if not isinstance(fills, Exception) and isinstance(fills, list):
            for fill in fills[:50]:
                recent_fills.append({
                    "coin":       fill.get("coin", ""),
                    "side":       fill.get("side", ""),
                    "price":      float(fill.get("px", "0") or "0"),
                    "size":       float(fill.get("sz", "0") or "0"),
                    "closed_pnl": float(fill.get("closedPnl", "0") or "0"),
                    "fee":        float(fill.get("fee", "0") or "0"),
                    "time":       fill.get("time", 0),
                    "order_type": "liquidation" if fill.get("liquidation") else "trade",
                })

        # Step 6: open orders
        orders: list[dict] = []
        if not isinstance(open_orders, Exception) and isinstance(open_orders, list):
            for order in open_orders:
                orders.append({
                    "coin":     order.get("coin", ""),
                    "side":     order.get("side", ""),
                    "price":    float(order.get("limitPx", "0") or "0"),
                    "size":     float(order.get("sz", "0") or "0"),
                    "order_id": order.get("oid", ""),
                    "time":     order.get("timestamp", 0),
                })

        usdc_spot = next(
            (b["total"] for b in spot_balances if b["coin"] == "USDC"), 0.0
        )

        return {
            "wallet_address":       wallet_address,
            "account_value":        round(total_account_value, 4),
            "unrealized_pnl":       round(total_unrealized_pnl, 4),
            "usdc_spot_balance":    round(usdc_spot, 4),
            "open_positions":       all_positions,
            "open_positions_count": len(all_positions),
            "spot_balances":        spot_balances,
            "recent_fills":         recent_fills,
            "open_orders":          orders,
            "dexes_queried":        dex_names,
        }

    # ------------------------------------------------------------------
    # Affiliation
    # ------------------------------------------------------------------

    async def check_affiliation(self, wallet_address: str, referral_code: str) -> bool:
        """Return True if *wallet_address* is referred by *referral_code*."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    INFO_ENDPOINT,
                    json={"type": "referral", "user": wallet_address},
                    headers={"Content-Type": "application/json"},
                    timeout=10.0,
                )
                data = response.json()
                referred_by = data.get("referredBy") or {}
                code = referred_by.get("code", "")
                result = code.strip().upper() == referral_code.strip().upper()
                print(f"[affiliation] referredBy={referred_by} code='{code}' expected='{referral_code}' result={result}")
                return result
        except Exception as e:
            print(f"[affiliation] ERROR type={type(e)} msg={e}")
            return False

    # ------------------------------------------------------------------
    # Legacy shims (kept for other routers)
    # ------------------------------------------------------------------

    async def get_user_state(self, wallet_address: str) -> dict:
        return await self.get_clearinghouse_state(wallet_address, "")

    async def get_user_positions(self, wallet_address: str) -> dict:
        return await self.get_user_state(wallet_address)

    async def get_account_info(self, address: str) -> dict:
        return await self.get_user_state(address)

    async def get_positions(self, address: str) -> list:
        state = await self.get_user_state(address)
        return state.get("assetPositions", [])

    async def place_order(self, payload: dict) -> dict:
        raise NotImplementedError("place_order not yet implemented")


hyperliquid_service = HyperliquidService()
