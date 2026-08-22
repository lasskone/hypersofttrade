"""
BotManager — manages lifecycle of trading bot instances.
Each bot runs as an asyncio Task inside the FastAPI process.
"""
from __future__ import annotations
import asyncio
import logging
import os
import uuid
from typing import Dict, Any
from datetime import datetime, timezone

from supabase import create_client

from services.db_utils import _run_db_call, _SUPABASE_CALL_TIMEOUT_S

logger = logging.getLogger(__name__)


def _supabase():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_KEY"])


async def _write_log(bot_id: str, level: str, message: str) -> None:
    """Async helper that performs the actual bot_logs insert.

    Always runs as a fire-and-forget asyncio Task (scheduled by _add_log).
    Fully silent on failure: a slow or broken bot_logs write must NEVER
    propagate into the trading path or stall the event loop.
    """
    try:
        db = _supabase()
        await _run_db_call(
            lambda: db.table("bot_logs").insert({
                "id":         str(uuid.uuid4()),
                "bot_id":     bot_id,
                "level":      level,
                "message":    message,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }).execute()
        )
    except asyncio.TimeoutError:
        logger.warning(
            "[bot_manager] _add_log timed out after %.0fs (non-fatal) — bot_id=%s",
            _SUPABASE_CALL_TIMEOUT_S, bot_id,
        )
    except Exception as exc:
        logger.warning(
            "[bot_manager] _add_log failed (non-fatal) — bot_id=%s: %s",
            bot_id, exc,
        )


class BotManager:
    def __init__(self):
        self._tasks: Dict[str, asyncio.Task] = {}

    async def start(self, bot_id: str, config: dict, wallet_address: str) -> None:
        if bot_id in self._tasks:
            return
        task = asyncio.create_task(self._run_bot(bot_id, config, wallet_address))
        self._tasks[bot_id] = task
        task.add_done_callback(lambda t: self._on_task_done(bot_id, t))
        try:
            db = _supabase()
            await _run_db_call(
                lambda: db.table("bots").update({
                    "status":     "running",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", bot_id).execute()
            )
        except asyncio.TimeoutError:
            logger.warning(
                "[bot_manager] start: bots status update timed out after %.0fs "
                "(non-fatal) — bot_id=%s",
                _SUPABASE_CALL_TIMEOUT_S, bot_id,
            )
        except Exception as exc:
            logger.warning(
                "[bot_manager] start: bots status update failed (non-fatal) — "
                "bot_id=%s: %s",
                bot_id, exc,
            )

    async def stop(self, bot_id: str) -> None:
        _STOP_TIMEOUT_S = 20.0
        task = self._tasks.pop(bot_id, None)
        if task:
            task.cancel()
            try:
                # asyncio.shield so that if wait_for's own timeout fires, it
                # cancels the shield future — not the underlying task a second
                # time — keeping task state clean while we surface the hang.
                await asyncio.wait_for(asyncio.shield(task), timeout=_STOP_TIMEOUT_S)
            except asyncio.CancelledError:
                pass  # clean cancellation — expected path
            except asyncio.TimeoutError:
                self._add_log(
                    bot_id, "error",
                    f"Bot {bot_id} task did not respond to cancellation within "
                    f"{_STOP_TIMEOUT_S}s — the worker event loop may be frozen; "
                    "manual worker restart may be required",
                )
        try:
            db = _supabase()
            await _run_db_call(
                lambda: db.table("bots").update({
                    "status":     "stopped",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", bot_id).execute()
            )
        except asyncio.TimeoutError:
            logger.warning(
                "[bot_manager] stop: bots status update timed out after %.0fs "
                "(non-fatal) — bot_id=%s",
                _SUPABASE_CALL_TIMEOUT_S, bot_id,
            )
        except Exception as exc:
            logger.warning(
                "[bot_manager] stop: bots status update failed (non-fatal) — "
                "bot_id=%s: %s",
                bot_id, exc,
            )

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
            # _on_task_done is a sync done-callback — cannot await directly.
            # Schedule the DB update as a fire-and-forget async task so the
            # event loop is never stalled by a blocking .execute() here.
            async def _update_error_status() -> None:
                try:
                    db = _supabase()
                    # IMPORTANT: also set desired_status='stopped' so the worker's
                    # reconcile_loop does NOT restart this bot automatically.
                    # Without this, the worker sees desired_status='running' + no local
                    # task → Case 1 → restarts → crashes again → infinite crash loop.
                    # The user must click Start explicitly to retry after a crash.
                    await _run_db_call(
                        lambda: db.table("bots").update({
                            "status":         "error",
                            "desired_status": "stopped",
                            "error_message":  str(exc),
                            "updated_at":     datetime.now(timezone.utc).isoformat(),
                        }).eq("id", bot_id).execute()
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "[bot_manager] _on_task_done: status update timed out after "
                        "%.0fs (non-fatal) — bot_id=%s",
                        _SUPABASE_CALL_TIMEOUT_S, bot_id,
                    )
                except Exception as db_exc:
                    logger.warning(
                        "[bot_manager] _on_task_done: status update failed "
                        "(non-fatal) — bot_id=%s: %s",
                        bot_id, db_exc,
                    )

            try:
                loop = asyncio.get_running_loop()
                loop.create_task(_update_error_status())
            except RuntimeError:
                pass  # no running loop — silently discard

            self._add_log(bot_id, "error", f"Bot crashed: {exc}")

    def _add_log(self, bot_id: str, level: str, message: str) -> None:
        """Schedule a fire-and-forget bot_logs write and return immediately.

        Never blocks the event loop, never raises. A slow or broken bot_logs
        insert is silently swallowed inside _write_log so it can NEVER freeze
        the trading path — this was the confirmed root cause of four freeze
        incidents where a synchronous .execute() stalled the entire event loop.
        """
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_write_log(bot_id, level, message))
        except RuntimeError:
            pass  # no running loop (e.g. called during shutdown) — silently discard

    async def _run_bot(self, bot_id: str, config: dict, wallet_address: str) -> None:
        from cryptography.fernet import Fernet
        bot_type = config.get("bot_type")
        if not bot_type:
            self._add_log(bot_id, "error", f"Bot {bot_id} has no bot_type in its config — refusing to start to avoid running the wrong strategy. Config keys: {list(config.keys())}")
            try:
                db = _supabase()
                await _run_db_call(
                    lambda: db.table("bots").update({
                        "status": "error", "desired_status": "stopped",
                    }).eq("id", bot_id).execute()
                )
            except (asyncio.TimeoutError, Exception) as exc:
                logger.warning(
                    "[bot_manager] _run_bot: status update failed (non-fatal) — "
                    "bot_id=%s: %s", bot_id, exc,
                )
            return
        self._add_log(bot_id, "info", f"Bot {bot_id} starting — type={bot_type} symbol={config.get('symbol')}")

        # Get user API key
        db = _supabase()
        result = await _run_db_call(
            lambda: db.table("users")
                .select("hyperliquid_api_key_encrypted, api_wallet_address")
                .ilike("wallet_address", wallet_address)
                .limit(1)
                .execute()
        )
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
        elif bot_type == "momentum_scalper":
            await self._run_momentum_scalper_bot(bot_id, config, wallet_address, private_key, api_wallet)
        elif bot_type == "momentum_fade_scalper":
            await self._run_fade_scalper_bot(bot_id, config, wallet_address, private_key, api_wallet)
        else:
            self._add_log(bot_id, "error", f"Unknown bot_type '{bot_type}' — no strategy registered for this type")
            try:
                db = _supabase()
                await _run_db_call(
                    lambda: db.table("bots").update({
                        "status": "error", "desired_status": "stopped",
                    }).eq("id", bot_id).execute()
                )
            except (asyncio.TimeoutError, Exception) as exc:
                logger.warning(
                    "[bot_manager] _run_bot: unknown bot_type status update failed "
                    "(non-fatal) — bot_id=%s: %s", bot_id, exc,
                )
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


    async def _run_momentum_scalper_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.momentum_scalper.strategy import MomentumScalperBot
        from services.hyperliquid_meta import get_sz_decimals

        symbols = list(config.get("symbols", ["BTC", "ETH", "SOL", "XRP", "HYPE"]))

        # Build sz_decimals_map concurrently for all symbols.
        decimals_list = await asyncio.gather(*[get_sz_decimals(sym) for sym in symbols])
        sz_decimals_map = dict(zip(symbols, decimals_list))

        # Only pass optional keys that are present in config — lets strategy defaults
        # apply without duplicating hardcoded values here.
        optional: dict = {}

        _float_keys = [
            "allocated_usdc",
            "min_score",
            "tp_atr_multiplier", "sl_atr_multiplier", "breakeven_atr_trigger",
            "martingale_multiplier",
            "risk_per_trade", "max_daily_loss_pct",
            "min_profit_to_fee_ratio", "estimated_fee_pct",
        ]
        _int_keys = [
            "leverage",
            "max_open_positions",
            "cooldown_after_trade_seconds", "cooldown_after_loss_seconds",
            "scan_interval_seconds",
            "max_consecutive_losses", "consecutive_loss_cooldown_minutes",
            "window_start_utc_hour", "window_end_utc_hour",
        ]
        _bool_keys = ["use_time_window"]

        for k in _float_keys:
            if config.get(k) is not None:
                optional[k] = float(config[k])
        for k in _int_keys:
            if config.get(k) is not None:
                optional[k] = int(config[k])
        for k in _bool_keys:
            if config.get(k) is not None:
                optional[k] = bool(config[k])

        bot = MomentumScalperBot(
            private_key     = private_key,
            master_address  = master_address,
            symbols         = symbols,
            sz_decimals_map = sz_decimals_map,
            db_client       = _supabase(),
            bot_id          = bot_id,
            log_callback    = lambda level, msg: self._add_log(bot_id, level, msg),
            **optional,
        )
        self._add_log(bot_id, "info", (
            f"Momentum Scalper initializing — symbols={symbols} "
            f"sz_decimals_map={sz_decimals_map} "
            f"allocation=${config.get('allocated_usdc', 200)} "
            f"min_score={config.get('min_score', 75)}"
        ))
        await bot.run()


    async def _run_fade_scalper_bot(self, bot_id: str, config: dict, master_address: str, private_key: str, api_wallet: str) -> None:
        from bots.momentum_fade_scalper.strategy import FadeScalperBot
        from services.hyperliquid_meta import get_sz_decimals

        symbols = list(config.get("symbols", ["BTC", "ETH", "SOL"]))

        # Build sz_decimals_map concurrently for all symbols.
        decimals_list = await asyncio.gather(*[get_sz_decimals(sym) for sym in symbols])
        sz_decimals_map = dict(zip(symbols, decimals_list))

        # Only pass optional keys that are present in config — lets strategy defaults
        # apply without duplicating hardcoded values here.
        optional: dict = {}

        _float_keys = [
            "allocated_usdc",
            "tp_atr_multiplier", "sl_atr_multiplier", "breakeven_atr_trigger",
            "risk_per_trade", "max_daily_loss_pct",
            "min_profit_to_fee_ratio", "estimated_fee_pct",
        ]
        _int_keys = [
            "leverage",
            "cooldown_after_trade_seconds", "cooldown_after_loss_seconds",
            "scan_interval_seconds",
            "max_consecutive_losses", "consecutive_loss_cooldown_minutes",
        ]

        for k in _float_keys:
            if config.get(k) is not None:
                optional[k] = float(config[k])
        for k in _int_keys:
            if config.get(k) is not None:
                optional[k] = int(config[k])

        # Build scanner_config from scanner-specific keys in config.
        _scanner_keys = ["min_efficiency_ratio", "min_volume_ratio", "max_spread_pct", "rsi_period"]
        scanner_config: dict = {}
        for k in _scanner_keys:
            if config.get(k) is not None:
                scanner_config[k] = float(config[k])
        if scanner_config:
            optional["scanner_config"] = scanner_config

        bot = FadeScalperBot(
            private_key     = private_key,
            master_address  = master_address,
            symbols         = symbols,
            sz_decimals_map = sz_decimals_map,
            db_client       = _supabase(),
            bot_id          = bot_id,
            log_callback    = lambda level, msg: self._add_log(bot_id, level, msg),
            **optional,
        )
        self._add_log(bot_id, "info", (
            f"Momentum Fade Scalper initializing — symbols={symbols} "
            f"sz_decimals_map={sz_decimals_map} "
            f"allocation=${config.get('allocated_usdc', 100)}"
        ))
        await bot.run()


bot_manager = BotManager()
