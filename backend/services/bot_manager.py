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
        else:
            raise ValueError(f"Unknown bot type: {bot_type}")

    async def _run_grid_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        import yaml, tempfile, os as _os
        from backend.bots.grid.engine import TradingEngine
        from backend.bots.grid.config import EnhancedBotConfig

        symbol = config["symbol"]
        allocated_usdc = float(config.get("allocated_usdc", 100))
        levels = int(config.get("levels", 10))
        range_pct = float(config.get("range_pct", 5.0))
        stop_loss_pct = float(config.get("stop_loss_pct", 5.0))
        take_profit_pct = float(config.get("take_profit_pct", 20.0))
        dex = config.get("dex", "")

        # Build YAML config that the grid engine expects
        symbol_full = f"{dex}:{symbol}" if dex else symbol
        yaml_config = {
            "name": config.get("name", "Grid Bot"),
            "active": True,
            "exchange": {"type": "hyperliquid", "testnet": False},
            "account": {"max_allocation_pct": 100},
            "grid": {
                "symbol": symbol_full,
                "levels": levels,
                "price_range": {"mode": "auto", "auto": {"range_pct": range_pct}}
            },
            "risk_management": {
                "stop_loss_enabled": stop_loss_pct > 0,
                "stop_loss_pct": stop_loss_pct,
                "take_profit_enabled": take_profit_pct > 0,
                "take_profit_pct": take_profit_pct,
                "tpsl_mode": "polling",
                "max_drawdown_pct": stop_loss_pct * 2,
                "max_position_size_pct": 100,
                "rebalance": {"price_move_threshold_pct": range_pct / 2}
            },
            "monitoring": {"log_level": "INFO"}
        }

        # Write temp YAML file
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            yaml.dump(yaml_config, f)
            yaml_path = f.name

        try:
            bot_config = EnhancedBotConfig.from_yaml(yaml_path)
            engine = TradingEngine(
                config=bot_config,
                private_key=private_key,
                wallet_address=master_address,
                allocated_usdc=allocated_usdc,
            )
            self._add_log(bot_id, "info", f"Grid engine initialized for {symbol_full} — {levels} levels ±{range_pct}%")
            await engine.run()
        finally:
            _os.unlink(yaml_path)


bot_manager = BotManager()
