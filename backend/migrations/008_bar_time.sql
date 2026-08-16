-- Migration 008: Add bar_time to technical_signals
--
-- WHY: detected_at is the DB insertion time, which can lag up to 5 minutes behind
-- the actual candle close (due to the scan cycle interval). bar_time records the
-- open timestamp of the candle whose close triggered the signal — this is the
-- timestamp users need to locate the exact bar on TradingView or any chart tool.
--
-- NULLABLE so existing rows are not affected by this migration.
--
-- HOW TO APPLY: Run once in the Supabase SQL editor (Dashboard → SQL Editor → Run).

ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS bar_time TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_technical_signals_bar_time
    ON technical_signals(bar_time DESC);
