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

from services.hyperliquid_meta import get_sz_decimals

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

        if bot_type == "trend_magic":
            await self._run_trend_magic_bot(bot_id, config, wallet_address, private_key, api_wallet)
        else:
            self._add_log(bot_id, "error", f"Unknown bot_type '{bot_type}' — no strategy registered for this type")
            db = _supabase()
            db.table("bots").update({"status": "error", "desired_status": "stopped"}).eq("id", bot_id).execute()
            raise ValueError(f"Unknown bot type: {bot_type}")

    async def _run_trend_magic_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.trend_magic.strategy import TrendMagicBot

        symbol = config.get("symbol", "BTC")
        dex    = config.get("dex", "") or None
        coin   = f"{dex}:{symbol}" if dex else symbol

        tm_optional_kwargs = {}
        for key in ("entry_amount_usdc", "dca1_amount_usdc", "dca2_amount_usdc"):
            if config.get(key) is not None:
                tm_optional_kwargs[key] = float(config[key])

        bot = TrendMagicBot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=float(config.get("allocated_usdc", 100)),
            sz_decimals=await get_sz_decimals(coin),
            leverage=int(config.get("leverage", 1)),
            interval=config.get("interval", "1h"),
            rsi_period=int(config.get("rsi_period", 14)),
            rsi_overbought=float(config.get("rsi_overbought", 70.0)),
            rsi_oversold=float(config.get("rsi_oversold", 30.0)),
            ema_period=int(config.get("ema_period", 200)),
            dca_level_1_pct=float(config.get("dca_level_1_pct", 7.0)),
            dca_level_2_pct=float(config.get("dca_level_2_pct", 14.0)),
            tp_pct=float(config.get("tp_pct", 5.0)),
            trailing_stop_pct=float(config.get("trailing_stop_pct", 1.0)),
            stop_loss_pct=float(config.get("stop_loss_pct", 10.0)),
            sides=config.get("sides") or ["long", "short"],
            dex=dex,
            scan_pairs=config.get("scan_pairs", False),
            scan_symbols=config.get("scan_symbols") or [],
            log_callback=lambda level, msg: self._add_log(bot_id, level, msg),
            db_client=_supabase(),
            bot_id=bot_id,
            **tm_optional_kwargs,
        )
        self._add_log(bot_id, "info", (
            f"Trend Magic Bot initializing — {coin} "
            f"RSI({config.get('rsi_period', 14)}) EMA({config.get('ema_period', 200)}) "
            f"sides={config.get('sides', ['long', 'short'])} allocation=${config.get('allocated_usdc', 100)}"
        ))
        await bot.run()


bot_manager = BotManager()
