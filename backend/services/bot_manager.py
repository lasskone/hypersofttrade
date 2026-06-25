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

        if bot_type == "grid":
            await self._run_grid_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "envelope_dca":
            await self._run_envelope_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "funding_rate":
            await self._run_funding_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "bb_rsi":
            await self._run_bbrsi_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "ema_cross":
            await self._run_emacross_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "passivbot_dca":
            await self._run_passivbot_dca_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "golden_trap":
            await self._run_golden_trap_bot(bot_id, config, wallet_address, private_key, api_wallet)
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
        # Always call update_leverage — including for 1x — so the exchange is
        # explicitly set to the configured value and never inherits stale leverage
        # from a previous bot session or manual trade.
        self._add_log(bot_id, "info", f"Setting leverage to {leverage}x for {symbol_full} (from config)")
        try:
            from hyperliquid.exchange import Exchange
            import eth_account
            from hyperliquid.utils import constants
            account = eth_account.Account.from_key(private_key)
            ex = Exchange(account, constants.MAINNET_API_URL, account_address=master_address)
            result = await asyncio.to_thread(ex.update_leverage, leverage, symbol_full, False)
            status = (result or {}).get("status", "")
            if status == "ok":
                self._add_log(bot_id, "info", f"Leverage set to {leverage}x for {symbol_full}")
            else:
                self._add_log(bot_id, "warning", f"Leverage update unexpected response for {symbol_full}: {result}")
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
        sz_decimals = await get_sz_decimals(coin)
        leverage = int(config.get("leverage", 1))
        interval = config.get("interval", "4h")

        def log_callback(level: str, message: str):
            self._add_log(bot_id, level, message)

        sides = config.get("sides") or ["long"]

        bot = EnvelopeBot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=allocated_usdc,
            ma_period=ma_period,
            envelopes=envelopes,
            stop_loss_pct=stop_loss_pct,
            sz_decimals=sz_decimals,
            leverage=leverage,
            interval=interval,
            dex=dex,
            sides=sides,
            log_callback=log_callback,
        )

        self._add_log(bot_id, "info", f"Envelope Bot initializing — {coin} MA={ma_period} envelopes={envelopes} sides={sides} allocation=${allocated_usdc}")
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
            sz_decimals=await get_sz_decimals(coin),
            min_hold_hours=int(config.get("min_hold_hours", 4)),
            scan_all_pairs=bool(config.get("scan_all_pairs", False)),
            dex=dex,
            log_callback=lambda level, msg: self._add_log(bot_id, level, msg),
        )
        self._add_log(bot_id, "info", f"Funding Rate Bot initializing — {coin}")
        await bot.run()

    async def _run_bbrsi_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.bbrsi.strategy import BBRSIBot
        symbol = config.get("symbol", "BTC")
        dex = config.get("dex", "") or None
        coin = f"{dex}:{symbol}" if dex else symbol
        bot = BBRSIBot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=float(config.get("allocated_usdc", 100)),
            leverage=int(config.get("leverage", 1)),
            bb_period=int(config.get("bb_period", 20)),
            bb_std=float(config.get("bb_std", 2.0)),
            rsi_period=int(config.get("rsi_period", 14)),
            rsi_oversold=float(config.get("rsi_oversold", 30)),
            rsi_overbought=float(config.get("rsi_overbought", 70)),
            stop_loss_pct=float(config.get("stop_loss_pct", 5)),
            sz_decimals=await get_sz_decimals(coin),
            interval=config.get("interval", "4h"),
            dex=dex,
            log_callback=lambda level, msg: self._add_log(bot_id, level, msg),
        )
        self._add_log(bot_id, "info", f"BB+RSI Bot initializing — {coin}")
        await bot.run()

    async def _run_emacross_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.emacross.strategy import EMACrossBot
        symbol = config.get("symbol", "BTC")
        dex = config.get("dex", "") or None
        coin = f"{dex}:{symbol}" if dex else symbol
        bot = EMACrossBot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=float(config.get("allocated_usdc", 100)),
            leverage=int(config.get("leverage", 1)),
            ema_fast=int(config.get("ema_fast", 9)),
            ema_slow=int(config.get("ema_slow", 21)),
            stop_loss_pct=float(config.get("stop_loss_pct", 5)),
            use_atr_stop=bool(config.get("use_atr_stop", False)),
            atr_multiplier=float(config.get("atr_multiplier", 2.0)),
            sz_decimals=await get_sz_decimals(coin),
            interval=config.get("interval", "4h"),
            dex=dex,
            log_callback=lambda level, msg: self._add_log(bot_id, level, msg),
        )
        self._add_log(bot_id, "info", f"EMA Cross Bot initializing — {coin}")
        await bot.run()

    async def _run_passivbot_dca_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.passivbot_dca.strategy import PassivbotDCABot

        symbol = config.get("symbol", "BTC")
        dex = config.get("dex", "") or None
        coin = f"{dex}:{symbol}" if dex else symbol

        bot = PassivbotDCABot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=float(config.get("allocated_usdc", 100)),
            leverage=int(config.get("leverage", 1)),
            direction=config.get("direction", "long"),
            wallet_exposure_limit=float(config.get("wallet_exposure_limit", 0.1)),
            entry_initial_qty_pct=float(config.get("entry_initial_qty_pct", 0.01)),
            double_down_factor=float(config.get("double_down_factor", 0.9)),
            entry_grid_spacing_pct=float(config.get("entry_grid_spacing_pct", 0.003)),
            entry_grid_spacing_we_weight=float(config.get("entry_grid_spacing_we_weight", 0.5)),
            close_grid_markup_start=float(config.get("close_grid_markup_start", 0.001)),
            close_grid_markup_end=float(config.get("close_grid_markup_end", 0.003)),
            close_grid_qty_pct=float(config.get("close_grid_qty_pct", 0.05)),
            trailing_enabled=bool(config.get("trailing_enabled", False)),
            trailing_threshold_pct=float(config.get("trailing_threshold_pct", 0.02)),
            trailing_retracement_pct=float(config.get("trailing_retracement_pct", 0.005)),
            unstuck_enabled=bool(config.get("unstuck_enabled", True)),
            unstuck_loss_allowance_pct=float(config.get("unstuck_loss_allowance_pct", 0.02)),
            unstuck_close_pct=float(config.get("unstuck_close_pct", 0.02)),
            sz_decimals=await get_sz_decimals(coin),
            dex=dex,
            log_callback=lambda level, msg: self._add_log(bot_id, level, msg),
        )
        self._add_log(bot_id, "info", f"Passivbot DCA Grid Bot initializing — {coin}")
        await bot.run()

    async def _run_golden_trap_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.golden_trap.strategy import GoldenTrapBot

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
        sz_decimals = await get_sz_decimals(coin)
        leverage = int(config.get("leverage", 1))
        interval = config.get("interval", "4h")
        sides = config.get("sides") or ["long"]
        trailing_stop_type = config.get("trailing_stop_type", "fixed")
        trailing_stop_pct = float(config.get("trailing_stop_pct", 2.0))
        trailing_stop_atr_mult = float(config.get("trailing_stop_atr_mult", 1.5))

        def log_callback(level: str, message: str):
            self._add_log(bot_id, level, message)

        bot = GoldenTrapBot(
            private_key=private_key,
            master_address=master_address,
            coin=coin,
            allocated_usdc=allocated_usdc,
            ma_period=ma_period,
            envelopes=envelopes,
            stop_loss_pct=stop_loss_pct,
            sz_decimals=sz_decimals,
            leverage=leverage,
            interval=interval,
            dex=dex,
            sides=sides,
            trailing_stop_type=trailing_stop_type,
            trailing_stop_pct=trailing_stop_pct,
            trailing_stop_atr_mult=trailing_stop_atr_mult,
            log_callback=log_callback,
        )

        self._add_log(bot_id, "info", (
            f"Golden Trap Bot initializing — {coin} MA={ma_period} envelopes={envelopes} "
            f"sides={sides} trailing={trailing_stop_type} allocation=${allocated_usdc}"
        ))
        await bot.run()


bot_manager = BotManager()
