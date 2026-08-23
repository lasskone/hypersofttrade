-- Migration 013: Add initial_entry_size and entry_atr columns to bot_risk_state.
--
-- PURPOSE: Persist the two position-lifetime constants needed to reconstruct
-- exact martingale sizing and trigger distances after a Worker restart.
--
-- BACKGROUND: On a Worker restart with an open position, three in-memory fields
-- are unrecoverable from any existing data source:
--   _martingale_level    — now tracked via position_orders (after migration 012)
--   _initial_entry_size  — the L0 fill size, basis for Fibonacci layer sizing
--   _entry_atr           — ATR frozen at initial entry, basis for trigger distances
--
-- Without _initial_entry_size, future martingale layer sizes are wrong:
--     layer_N_size = φ^(N-1) × _initial_entry_size
-- Without _entry_atr, trigger prices are wrong (or must be approximated from
-- current candles, which may differ from the original entry-moment value):
--     trigger_N = N × sl_atr_multiplier × _entry_atr  adverse from _initial_entry_price
--
-- These values are fixed for the entire lifetime of a trade (set at L0 fill
-- and never updated). They are written once at initial entry alongside
-- active_coin/martingale_level/next_martingale_trigger_px, and left in place
-- on position close (no harm in retaining them; they are overwritten on the
-- next entry).
--
-- HOW TO APPLY: Run once in the Supabase SQL editor
--   (Dashboard → SQL Editor → Run). IF NOT EXISTS guards make it safe to re-run.
--   Pre-existing rows get NULL for both new columns, which is correct — a bot
--   that is currently idle has no meaningful entry_size or entry_atr to store.

ALTER TABLE bot_risk_state
    ADD COLUMN IF NOT EXISTS initial_entry_size NUMERIC,
    ADD COLUMN IF NOT EXISTS entry_atr           NUMERIC;
