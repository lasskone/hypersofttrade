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
        bot_type = config.get("bot_type")
        if not bot_type:
            self._add_log(bot_id, "error", f"Bot {bot_id} has no bot_type in its config — refusing to start to avoid running the wrong strategy. Config keys: {list(config.keys())}")
            db = _supabase()
            db.table("bots").update({"status": "error", "desired_status": "stopped"}).eq("id", bot_id).execute()
            return
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

        if bot_type == "rsi_dca":
            await self._run_rsi_dca_bot(bot_id, config, wallet_address, private_key, api_wallet)
        else:
            self._add_log(bot_id, "error", f"Unknown bot_type '{bot_type}' — no strategy registered for this type")
            db = _supabase()
            db.table("bots").update({"status": "error", "desired_status": "stopped"}).eq("id", bot_id).execute()
            raise ValueError(f"Unknown bot type: {bot_type}")

    async def _run_rsi_dca_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.rsi_dca_grid.strategy import RSIDCAGridBot
        from services.hyperliquid_meta import get_sz_decimals

        symbol = config.get("symbol", "BTC")
        dex    = config.get("dex", "") or ""
        coin   = f"{dex}:{symbol}" if dex else symbol

        # Only pass optional keys that are present in config — lets strategy defaults
        # apply without duplicating hardcoded values here.
        optional: dict = {}

        _float_keys = [
            "allocated_usdc",
            "sl_pct", "tp_pct",
            "adx_threshold", "rsi_oversold", "rsi_overbought",
            "volume_multiplier",
        ]
        _int_keys = [
            "leverage", "ema_period", "adx_period",
            "rsi_period", "volume_lookback",
            "window_start_utc_hour", "window_end_utc_hour",
            "cooldown_candles",
        ]
        _bool_keys = ["use_adx_filter", "use_time_window", "use_volume_filter"]
        _str_keys  = ["entry_timeframe", "context_timeframe"]

        for k in _float_keys:
            if config.get(k) is not None:
                optional[k] = float(config[k])
        for k in _int_keys:
            if config.get(k) is not None:
                optional[k] = int(config[k])
        for k in _bool_keys:
            if config.get(k) is not None:
                optional[k] = bool(config[k])
        for k in _str_keys:
            if config.get(k) is not None:
                optional[k] = str(config[k])
        if config.get("sides") is not None:
            optional["sides"] = list(config["sides"])
        if config.get("dca_pcts") is not None:
            optional["dca_pcts"] = [float(p) for p in config["dca_pcts"]]

        sz_decimals = await get_sz_decimals(coin)
        bot = RSIDCAGridBot(
            private_key    = private_key,
            master_address = master_address,
            coin           = coin,
            sz_decimals    = sz_decimals,
            dex            = dex,
            db_client      = _supabase(),
            bot_id         = bot_id,
            log_callback   = lambda level, msg: self._add_log(bot_id, level, msg),
            **optional,
        )
        self._add_log(bot_id, "info", (
            f"RSI DCA Grid Bot initializing — {coin} "
            f"sz_decimals={sz_decimals} "
            f"sides={config.get('sides', ['long', 'short'])} "
            f"allocation=${config.get('allocated_usdc', 100)} "
            f"dca_pcts={config.get('dca_pcts', [2.0, 4.0, 7.0, 12.0])}"
        ))
        await bot.run()


bot_manager = BotManager()
