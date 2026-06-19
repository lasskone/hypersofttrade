"""
BotManager — manages lifecycle of trading bot instances.
Each bot runs as an asyncio Task inside the FastAPI process.
"""
from __future__ import annotations
import asyncio
import os
import uuid
from typing import Dict, Any
from datetime import datetime, timezone

from supabase import create_client

def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


class BotManager:
    def __init__(self):
        self._tasks: Dict[str, asyncio.Task] = {}

    async def start(self, bot_id: str, config: dict, wallet_address: str) -> None:
        if bot_id in self._tasks:
            return
        task = asyncio.create_task(self._run_bot(bot_id, config, wallet_address))
        self._tasks[bot_id] = task
        task.add_done_callback(lambda t: self._on_task_done(bot_id, t))
        db = _supabase()
        db.table("bots").update({"status": "running", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", bot_id).execute()

    async def stop(self, bot_id: str) -> None:
        task = self._tasks.pop(bot_id, None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        db = _supabase()
        db.table("bots").update({"status": "stopped", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", bot_id).execute()

    def list_running(self) -> list[str]:
        return list(self._tasks.keys())

    def is_running(self, bot_id: str) -> bool:
        return bot_id in self._tasks

    def _on_task_done(self, bot_id: str, task: asyncio.Task) -> None:
        self._tasks.pop(bot_id, None)
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            db = _supabase()
            db.table("bots").update({
                "status": "error",
                "error_message": str(exc),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }).eq("id", bot_id).execute()
            self._add_log(bot_id, "error", f"Bot crashed: {exc}")

    def _add_log(self, bot_id: str, level: str, message: str) -> None:
        try:
            db = _supabase()
            db.table("bot_logs").insert({
                "id": str(uuid.uuid4()),
                "bot_id": bot_id,
                "level": level,
                "message": message,
                "created_at": datetime.now(timezone.utc).isoformat()
            }).execute()
        except Exception:
            pass

    async def _run_bot(self, bot_id: str, config: dict, wallet_address: str) -> None:
        from cryptography.fernet import Fernet
        bot_type = config.get("bot_type", "grid")
        self._add_log(bot_id, "info", f"Bot {bot_id} starting — type={bot_type} symbol={config.get('symbol')}")

        # Get user API key
        db = _supabase()
        result = db.table("users").select("hyperliquid_api_key_encrypted, api_wallet_address").ilike("wallet_address", wallet_address).limit(1).execute()
        if not result.data:
            raise ValueError("No API key found for user")
        encrypted = result.data[0]["hyperliquid_api_key_encrypted"]
        if not encrypted:
            raise ValueError("API key not configured")
        key = os.environ["ENCRYPTION_KEY"].encode()
        private_key = Fernet(key).decrypt(encrypted.encode()).decode()
        api_wallet = result.data[0]["api_wallet_address"]

        if bot_type == "grid":
            await self._run_grid_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "envelope_dca":
            await self._run_envelope_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "funding_rate":
            await self._run_funding_bot(bot_id, config, wallet_address, private_key, api_wallet)
        else:
            raise ValueError(f"Unknown bot type: {bot_type}")

    async def _run_grid_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.grid.engine import TradingEngine

        symbol = config.get("symbol", "BTC")
        dex = config.get("dex", "")
        symbol_full = f"{dex}:{symbol}" if dex else symbol
        allocated_usdc = float(config.get("allocated_usdc", 100))
        levels = int(config.get("levels", 10))
        range_pct = float(config.get("range_pct", 5.0))
        stop_loss_pct = float(config.get("stop_loss_pct", 5.0))
        take_profit_pct = float(config.get("take_profit_pct", 20.0))

        engine_config = {
            "name": config.get("name", "Grid Bot"),
            "exchange": {"type": "hyperliquid", "testnet": False},
            # "strategy" is what TradingEngine._initialize_strategy() and start() read
            "strategy": {
                "type": "basic_grid",
                "symbol": symbol_full,
                "levels": levels,
                "range_pct": range_pct,
                "total_allocation": allocated_usdc,
                "rebalance_threshold_pct": range_pct / 2,
            },
            "risk_management": {
                "stop_loss_enabled": stop_loss_pct > 0,
                "stop_loss_pct": stop_loss_pct,
                "take_profit_enabled": take_profit_pct > 0,
                "take_profit_pct": take_profit_pct,
                "tpsl_mode": "polling",
                "max_drawdown_pct": stop_loss_pct * 2,
                "max_position_size_pct": 200,
            },
            "monitoring": {"log_level": "INFO"},
            "bot_config": {
                "name": config.get("name", "Grid Bot"),
                "mainnet_private_key": private_key,
                "mainnet_wallet_address": master_address,
            }
        }

        self._add_log(bot_id, "info", f"Grid engine starting — {symbol_full} {levels} levels ±{range_pct}% allocation=${allocated_usdc}")

        leverage = int(config.get("leverage", 1))
        engine = TradingEngine(engine_config)
        if not await engine.initialize():
            raise RuntimeError("TradingEngine failed to initialize")
        if leverage > 1:
            try:
                from hyperliquid.exchange import Exchange
                import eth_account
                from hyperliquid.utils import constants
                account = eth_account.Account.from_key(private_key)
                ex = Exchange(account, constants.MAINNET_API_URL, account_address=master_address)
                await asyncio.to_thread(ex.update_leverage, leverage, symbol_full, False)
                self._add_log(bot_id, "info", f"Leverage set to {leverage}x for {symbol_full}")
            except Exception as e:
                self._add_log(bot_id, "warning", f"Failed to set leverage: {e}")
        await engine.start()


    async def _run_envelope_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.envelope.strategy import EnvelopeBot

        symbol = config.get("symbol", "BTC")
        dex = config.get("dex", "") or None
        coin = f"{dex}:{symbol}" if dex else symbol
        allocated_usdc = float(config.get("allocated_usdc", 100))
        ma_period = int(config.get("ma_period", 5))
        envelopes = [
            float(config.get("envelope_1_pct", 7)) / 100,
            float(config.get("envelope_2_pct", 10)) / 100,
            float(config.get("envelope_3_pct", 15)) / 100,
        ]
        stop_loss_pct = float(config.get("stop_loss_pct", 10))
        sz_decimals = int(config.get("sz_decimals", 5))
        leverage = int(config.get("leverage", 1))

        def log_callback(level: str, message: str):
            self._add_log(bot_id, level, message)

        bot = EnvelopeBot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=allocated_usdc,
            ma_period=ma_period,
            envelopes=envelopes,
            stop_loss_pct=stop_loss_pct,
            sz_decimals=sz_decimals,
            dex=dex,
            leverage=leverage,
            log_callback=log_callback,
        )

        self._add_log(bot_id, "info", f"Envelope Bot initializing — {coin} MA={ma_period} envelopes={envelopes} allocation=${allocated_usdc}")
        await bot.run()

    async def _run_funding_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.funding.strategy import FundingRateBot

        symbol = config.get("symbol", "BTC")
        dex = config.get("dex", "") or None
        coin = f"{dex}:{symbol}" if dex else symbol

        bot = FundingRateBot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=float(config.get("allocated_usdc", 100)),
            leverage=int(config.get("leverage", 1)),
            entry_threshold_pct=float(config.get("entry_threshold_pct", 0.01)),
            exit_threshold_pct=float(config.get("exit_threshold_pct", 0.005)),
            sz_decimals=int(config.get("sz_decimals", 5)),
            min_hold_hours=int(config.get("min_hold_hours", 4)),
            dex=dex,
            log_callback=lambda level, msg: self._add_log(bot_id, level, msg),
        )
        self._add_log(bot_id, "info", f"Funding Rate Bot initializing — {coin}")
        await bot.run()


bot_manager = BotManager()
