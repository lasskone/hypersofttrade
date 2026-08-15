-- Migration 006: trade_signals table
-- Captures full indicator breakdown per trade for analysis.
-- Linked to position_groups (cascades on delete) and bots (set null on delete).

CREATE TABLE IF NOT EXISTS trade_signals (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    position_group_id  UUID        REFERENCES position_groups(id) ON DELETE CASCADE,
    bot_id             UUID        REFERENCES bots(id) ON DELETE SET NULL,
    coin               TEXT        NOT NULL,
    side               TEXT        NOT NULL CHECK (side IN ('long', 'short')),
    entry_price        NUMERIC     NOT NULL,
    score_total        NUMERIC     NOT NULL,
    trend_score        NUMERIC,
    momentum_score     NUMERIC,
    volume_score       NUMERIC,
    volatility_score   NUMERIC,
    pullback_score     NUMERIC,
    structure_score    NUMERIC,
    execution_score    NUMERIC,
    ema_sep_pct        NUMERIC,
    rsi_m5             NUMERIC,
    adx_m5             NUMERIC,
    rsi_m1             NUMERIC,
    atr_pct            NUMERIC,
    volume_ratio_m1    NUMERIC,
    spread_pct         NUMERIC,
    depth_usd          NUMERIC,
    outcome            TEXT        CHECK (outcome IN ('TP_HIT', 'SL_HIT', 'CLOSED_UNKNOWN')),
    pnl_usd            NUMERIC,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    closed_at          TIMESTAMPTZ
);

ALTER TABLE trade_signals ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_trade_signals_bot_id            ON trade_signals(bot_id);
CREATE INDEX IF NOT EXISTS idx_trade_signals_position_group_id ON trade_signals(position_group_id);
CREATE INDEX IF NOT EXISTS idx_trade_signals_outcome           ON trade_signals(outcome);
