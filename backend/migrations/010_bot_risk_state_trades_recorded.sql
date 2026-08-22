-- Migration 010: Add trades_recorded column to bot_risk_state.
--
-- PURPOSE: Persist the count of trade results recorded by RiskManager across
-- worker restarts, so sync_allocation() and load_or_init() can reliably
-- distinguish "no trades ever" (safe to rebaseline equity to allocated_usdc)
-- from "bot just restarted with real trade history" (must NOT rebaseline).
--
-- BACKGROUND: self._trades_recorded was added as an in-memory counter in
-- risk_manager.py to fix the sync_allocation() bug where equity == HWM was
-- incorrectly treated as "no trades" — it is also true after any profitable
-- trade because record_trade_result bumps both equity and HWM simultaneously.
-- Without this column, _trades_recorded resets to 0 on every worker restart
-- and the rebaseline bug reappears after each redeploy.
--
-- HOW TO APPLY: Run once in the Supabase SQL editor
--   (Dashboard → SQL Editor → Run). IF NOT EXISTS / DEFAULT guards make it
--   safe to re-run. Pre-existing rows get trades_recorded = 0, which is
--   conservative: the bot will allow one rebaseline attempt on next startup,
--   then lock in the correct value after the first trade.

ALTER TABLE bot_risk_state
    ADD COLUMN IF NOT EXISTS trades_recorded INT NOT NULL DEFAULT 0;
