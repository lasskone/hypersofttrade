-- Migration 009: per-bot equity history for live PnL curve
-- Additive only — insert-only table, no existing schema changes.

CREATE TABLE IF NOT EXISTS bot_equity_history (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id         UUID        NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    equity         NUMERIC     NOT NULL,
    pnl_usd        NUMERIC     NOT NULL,
    cumulative_pnl NUMERIC     NOT NULL,
    recorded_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bot_equity_history ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_bot_equity_history_bot_id_time
    ON bot_equity_history(bot_id, recorded_at);
