-- Migration 007: Technical scanner tables
--
-- WHY: Supports a standalone market scanner that watches user-defined coins
-- across 15m/1h/4h timeframes and detects RSI divergence, EMA crossovers,
-- and price breakouts — independently of any bot strategy.
--
-- HOW TO APPLY: Run once in the Supabase SQL editor (Dashboard → SQL Editor →
-- Run).  IF NOT EXISTS guards make it safe to re-run.

-- ---------------------------------------------------------------------------
-- Table: scanner_watchlist
-- Coins the scanner should monitor per wallet.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scanner_watchlist (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL,
    coin           TEXT NOT NULL,
    dex            TEXT,
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wallet_address, coin, dex)
);

ALTER TABLE scanner_watchlist ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Table: technical_signals
-- One row per signal detected per coin/timeframe/type combination.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS technical_signals (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address    TEXT NOT NULL,
    coin              TEXT NOT NULL,
    timeframe         TEXT NOT NULL CHECK (timeframe IN ('15m','1h','4h')),
    signal_type       TEXT NOT NULL CHECK (signal_type IN (
                          'rsi_divergence_bullish',
                          'rsi_divergence_bearish',
                          'ema200_cross_up',
                          'ema200_cross_down',
                          'ema361_cross_up',
                          'ema361_cross_down',
                          'breakout_up',
                          'breakout_down'
                      )),
    price             NUMERIC NOT NULL,
    detected_at       TIMESTAMPTZ DEFAULT NOW(),
    notified_app      BOOLEAN NOT NULL DEFAULT FALSE,
    notified_telegram BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE technical_signals ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_technical_signals_wallet_coin
    ON technical_signals(wallet_address, coin);
CREATE INDEX IF NOT EXISTS idx_technical_signals_detected_at
    ON technical_signals(detected_at DESC);
