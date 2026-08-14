-- Migration 005: Add bot_risk_state table.
--
-- PURPOSE: Persist per-bot risk-management state across Railway restarts.
-- This is a hard requirement — drawdown protection must survive redeploys.
--
-- EQUITY ACCOUNTING MODEL:
--   equity starts at allocated_usdc at first boot and is updated after every
--   closed trade using the strategy's own computed realized PnL:
--       pnl_usd = (exit_price - entry_price) × size × (1 if long else -1)
--   Exit price is the mark price fetched immediately when a position close is
--   detected (not the exact trigger fill price). This makes pnl_usd an
--   approximation that does NOT include funding or fees, and should NOT be
--   used for accounting or tax purposes. It exists solely to drive
--   risk-sizing (position sizes scale with equity) and drawdown-protection
--   (trading halts when equity drops too far from the high-water mark).
--
-- HIGH WATER MARK (HWM): updated whenever equity exceeds the previous HWM.
--   Drawdown tiers and the daily-loss ceiling are both denominated relative
--   to the *current equity*, not the HWM, so a bot recovering from a
--   drawdown does not get a larger absolute daily-loss budget than its
--   current balance can support.
--
-- RESTART SAFETY: Railway redeploys must NEVER reset this table. The bot's
--   load_or_init() reads from this table on startup and resumes from the
--   persisted state. A fresh row is only inserted when no row exists for the
--   given bot_id (i.e. first-ever run).
--
-- HOW TO APPLY: Run once in the Supabase SQL editor
--   (Dashboard → SQL Editor → Run). IF NOT EXISTS guards make it safe to re-run.

CREATE TABLE IF NOT EXISTS bot_risk_state (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id                UUID        UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
    equity                NUMERIC     NOT NULL,
    high_water_mark       NUMERIC     NOT NULL,
    daily_loss_usd        NUMERIC     NOT NULL DEFAULT 0,
    daily_loss_date       DATE        NOT NULL DEFAULT CURRENT_DATE,
    consecutive_losses    INT         NOT NULL DEFAULT 0,
    trading_halted        BOOLEAN     NOT NULL DEFAULT FALSE,
    halt_reason           TEXT,
    cooldown_until        TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bot_risk_state ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bot_risk_state_bot_id ON bot_risk_state(bot_id);
