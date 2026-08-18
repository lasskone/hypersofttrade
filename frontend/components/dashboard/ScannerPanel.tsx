'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://hypersofttrade-backend-production.up.railway.app';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface WatchlistEntry {
  id: string;
  wallet_address: string;
  coin: string;
  dex: string;
  active: boolean;
  created_at: string;
}

interface Signal {
  id: string;
  wallet_address: string;
  coin: string;
  timeframe: string;
  signal_type: string;
  price: number;
  detected_at: string;
  bar_time?: string | null;  // ISO timestamp of triggering candle open; null on old rows
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TIMEFRAMES = ['15m', '1h', '4h'] as const;
type TF = typeof TIMEFRAMES[number];

// Signal families: each family groups the bullish and bearish variants of the
// same underlying indicator.  For each coin×timeframe we show exactly ONE slot
// per family — the single most recent signal that belongs to that family.
// This eliminates contradictory stale entries (e.g. old Breakout Up + new
// Breakout Down both visible at once).
const SIGNAL_FAMILIES: Array<{ key: string; label: string; types: string[] }> = [
  { key: 'rsi_divergence', label: 'RSI Divergence', types: ['rsi_divergence_bullish', 'rsi_divergence_bearish'] },
  { key: 'ema200_cross',   label: 'EMA 200 Cross',  types: ['ema200_cross_up',        'ema200_cross_down']      },
  { key: 'ema361_cross',   label: 'EMA 361 Cross',  types: ['ema361_cross_up',        'ema361_cross_down']      },
  { key: 'breakout',       label: 'Breakout',        types: ['breakout_up',            'breakout_down']          },
];

const SIGNAL_LABELS: Record<string, string> = {
  rsi_divergence_bullish: 'RSI Divergence (Bullish)',
  rsi_divergence_bearish: 'RSI Divergence (Bearish)',
  ema200_cross_up:        'EMA 200 Cross Up',
  ema200_cross_down:      'EMA 200 Cross Down',
  ema361_cross_up:        'EMA 361 Cross Up',
  ema361_cross_down:      'EMA 361 Cross Down',
  breakout_up:            'Breakout Up',
  breakout_down:          'Breakout Down',
};

const isBullish = (signal_type: string) =>
  signal_type.endsWith('_bullish') || signal_type.endsWith('_up');

// 24-hour format. NOTE: HistoryPanel.tsx has its own separate local copy of
// fmtTime — this change does NOT affect HistoryPanel.
function fmtTime(isoString: string): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

function timeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// CoinAutocomplete — unchanged from original
// ---------------------------------------------------------------------------
function CoinAutocomplete({
  symbols,
  symbolsLoading,
  alreadyAdded,
  onAdd,
}: {
  symbols: string[];
  symbolsLoading: boolean;
  alreadyAdded: Set<string>;
  onAdd: (coin: string) => Promise<void>;
}) {
  const [query, setQuery]         = useState('');
  const [open, setOpen]           = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [adding, setAdding]       = useState(false);
  const containerRef              = useRef<HTMLDivElement>(null);
  const inputRef                  = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query.trim()
    ? symbols.filter(s => s.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 60)
    : symbols.slice(0, 60);

  const handleSelect = async (coin: string) => {
    if (alreadyAdded.has(coin)) return;
    setAdding(true);
    setQuery('');
    setOpen(false);
    setHighlighted(0);
    await onAdd(coin);
    setAdding(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) { if (e.key === 'ArrowDown' || e.key === 'Enter') setOpen(true); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlighted]) handleSelect(filtered[highlighted]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // Reset highlight when filtered list changes
  useEffect(() => { setHighlighted(0); }, [query]);

  const borderColor = open ? '#00d4aa88' : '#1a1a2e';

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1 }}>
      <input
        ref={inputRef}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={symbolsLoading ? 'Loading symbols…' : 'Search coin, e.g. ETH…'}
        disabled={symbolsLoading || adding}
        style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 8,
          background: '#0a0a0f',
          border: `1px solid ${borderColor}`,
          color: '#fff',
          fontSize: 13,
          outline: 'none',
          boxSizing: 'border-box',
          transition: 'border-color 0.15s',
        }}
      />

      {open && !symbolsLoading && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: '#0d0d14',
            border: '1px solid #1a1a2e',
            borderRadius: 8,
            maxHeight: 220,
            overflowY: 'auto',
            zIndex: 3000,
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: '12px 14px', color: '#6b7280', fontSize: 13 }}>
              No symbols match &ldquo;{query}&rdquo;
            </div>
          ) : (
            filtered.map((sym, i) => {
              const added = alreadyAdded.has(sym);
              return (
                <div
                  key={sym}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => handleSelect(sym)}
                  style={{
                    padding: '8px 14px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: added ? 'default' : 'pointer',
                    background: i === highlighted && !added ? '#1a1a2e' : 'transparent',
                    opacity: added ? 0.4 : 1,
                    fontSize: 13,
                    color: '#fff',
                    transition: 'background 0.1s',
                  }}
                >
                  <span>{sym}</span>
                  {added && <span style={{ fontSize: 11, color: '#00d4aa' }}>✓ added</span>}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignalItem — compact signal row inside a timeframe column
// ---------------------------------------------------------------------------
function SignalItem({ sig, isNewest = false }: { sig: Signal; isNewest?: boolean }) {
  const bullish = isBullish(sig.signal_type);
  const color   = bullish ? '#10b981' : '#ef4444';
  const tsStr   = sig.bar_time || sig.detected_at;

  return (
    <div style={{ paddingBottom: 8, borderBottom: '1px solid #0a0a0f' }}>
      {/* Signal badge + optional newest-star */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
        <div
          style={{
            display: 'inline-block',
            padding: '2px 6px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            background: `${color}18`,
            border: `1px solid ${color}40`,
            color,
            lineHeight: 1.4,
            wordBreak: 'break-word',
          }}
        >
          {SIGNAL_LABELS[sig.signal_type] || sig.signal_type}
        </div>
        {isNewest && (
          <span
            title="Most recent signal on this card"
            style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1, flexShrink: 0 }}
          >
            ★
          </span>
        )}
      </div>
      {/* Price */}
      <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace', marginBottom: 2 }}>
        {Number(sig.price).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        })}
      </div>
      {/* Timestamp */}
      <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>
        {fmtTime(tsStr)}
      </div>
      <div style={{ fontSize: 10, color: '#4b5563' }}>
        {timeAgo(tsStr)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimeframeColumn — one TF section inside a ticker card
//
// Shows exactly 4 slots — one per signal family — each displaying the single
// most recent signal for that family, or a muted placeholder if none exist.
// "Most recent" is determined by bar_time when available, else detected_at.
// ---------------------------------------------------------------------------
function TimeframeColumn({
  tf,
  sigs,
  isLast,
  newestId,
}: {
  tf: TF;
  sigs: Signal[];    // all signals for this coin×TF, already most-recent-first from API
  isLast: boolean;
  newestId: string | null;   // id of the card's single most recent signal, or null
}) {
  // For each family pick the signal with the latest timestamp.
  // API ordering (detected_at DESC) is usually sufficient, but we sort within
  // each family by bar_time/detected_at to handle the rare edge case where
  // bar_time ordering diverges from detected_at ordering.
  const tsOf = (s: Signal) => new Date(s.bar_time || s.detected_at).getTime();

  const familySlots = SIGNAL_FAMILIES.map(family => {
    const matching = sigs.filter(s => family.types.includes(s.signal_type));
    if (matching.length === 0) return { family, signal: null as Signal | null };
    const best = matching.reduce((a, b) => (tsOf(a) >= tsOf(b) ? a : b));
    return { family, signal: best };
  });

  return (
    <div
      style={{
        padding: '10px 10px 8px',
        borderRight: isLast ? 'none' : '1px solid #1a1a2e',
        minWidth: 0,
      }}
    >
      {/* TF label */}
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: '#4b5563',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 8,
        }}
      >
        {tf}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {familySlots.map(({ family, signal }) =>
          signal ? (
            <SignalItem key={family.key} sig={signal} isNewest={signal.id === newestId} />
          ) : (
            <div
              key={family.key}
              style={{
                paddingBottom: 8,
                borderBottom: '1px solid #0a0a0f',
                fontSize: 10,
                color: '#374151',
                fontStyle: 'italic',
              }}
            >
              No {family.label} signal yet
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TickerCard — one card per watchlist coin
// ---------------------------------------------------------------------------
function TickerCard({
  entry,
  coinSignals,
  onRemove,
}: {
  entry: WatchlistEntry;
  coinSignals: Record<string, Signal[]>;
  onRemove: (entry: WatchlistEntry) => void;
}) {
  // Count how many family×TF slots have at least one signal (max 12 = 4×3).
  const activeFamilySlots = TIMEFRAMES.reduce((total, tf) => {
    const tfSigs = coinSignals[tf] ?? [];
    return total + SIGNAL_FAMILIES.filter(
      fam => tfSigs.some(s => fam.types.includes(s.signal_type))
    ).length;
  }, 0);

  // Find the single most recent signal id across ALL family×TF slots on this
  // card.  This is the signal that gets the yellow star marker.
  const tsOf = (s: Signal) => new Date(s.bar_time || s.detected_at).getTime();
  let newestId: string | null = null;
  let newestTs = -Infinity;
  for (const tf of TIMEFRAMES) {
    const tfSigs = coinSignals[tf] ?? [];
    for (const fam of SIGNAL_FAMILIES) {
      const matching = tfSigs.filter(s => fam.types.includes(s.signal_type));
      if (matching.length === 0) continue;
      const best = matching.reduce((a, b) => (tsOf(a) >= tsOf(b) ? a : b));
      const t = tsOf(best);
      if (t > newestTs) { newestTs = t; newestId = best.id; }
    }
  }

  return (
    <div
      className="rounded-xl"
      style={{ backgroundColor: '#0d0d14', border: '1px solid #1a1a2e' }}
    >
      {/* Card header */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid #1a1a2e',
        }}
      >
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>
            {entry.coin}
          </span>
          {activeFamilySlots > 0 && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: '#6b7280',
                background: '#1a1a2e',
                borderRadius: 10,
                padding: '1px 6px',
              }}
            >
              {activeFamilySlots}/{SIGNAL_FAMILIES.length * TIMEFRAMES.length}
            </span>
          )}
        </div>
        <button
          onClick={() => onRemove(entry)}
          title={`Remove ${entry.coin} from watchlist`}
          style={{
            background: 'none',
            border: 'none',
            color: '#4b5563',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: '0 2px',
            borderRadius: 4,
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => ((e.target as HTMLButtonElement).style.color = '#ef4444')}
          onMouseLeave={e => ((e.target as HTMLButtonElement).style.color = '#4b5563')}
        >
          ×
        </button>
      </div>

      {/* 3-column timeframe grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
        {TIMEFRAMES.map((tf, idx) => (
          <TimeframeColumn
            key={tf}
            tf={tf}
            sigs={coinSignals[tf] ?? []}
            isLast={idx === TIMEFRAMES.length - 1}
            newestId={newestId}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ScannerPanel({ walletAddress }: { walletAddress: string }) {
  const [watchlist, setWatchlist]       = useState<WatchlistEntry[]>([]);
  const [signals, setSignals]           = useState<Signal[]>([]);
  const [loadingWl, setLoadingWl]       = useState(true);
  const [loadingSig, setLoadingSig]     = useState(true);
  const [symbols, setSymbols]           = useState<string[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(true);
  const [toast, setToast]               = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const toastTimer                      = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (type: 'success' | 'error', message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ type, message });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  // ── Fetch symbol list (once on mount) ────────────────────────────────────
  useEffect(() => {
    fetch(`${API_URL}/scanner/available-symbols`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setSymbols(data.symbols || []))
      .catch(() => setSymbols([]))
      .finally(() => setSymbolsLoading(false));
  }, []);

  // ── Fetch watchlist ──────────────────────────────────────────────────────
  const fetchWatchlist = async () => {
    try {
      const res = await fetch(
        `${API_URL}/scanner/watchlist?wallet_address=${encodeURIComponent(walletAddress)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      setWatchlist(data.watchlist || []);
    } catch {}
    finally { setLoadingWl(false); }
  };

  // ── Fetch signals ────────────────────────────────────────────────────────
  // Limit 500 (backend cap) so each watched coin has adequate history across
  // all 3 timeframes — a flat limit=100 gets exhausted quickly when many coins
  // are watched and one coin fires frequently.
  const fetchSignals = async () => {
    try {
      const res = await fetch(
        `${API_URL}/scanner/signals?wallet_address=${encodeURIComponent(walletAddress)}&limit=500`
      );
      if (!res.ok) return;
      const data = await res.json();
      setSignals(data.signals || []);
    } catch {}
    finally { setLoadingSig(false); }
  };

  useEffect(() => {
    fetchWatchlist();
    fetchSignals();
    const interval = setInterval(() => {
      fetchWatchlist();
      fetchSignals();
    }, 45_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // ── Add coin ─────────────────────────────────────────────────────────────
  const handleAdd = async (coin: string) => {
    try {
      const res = await fetch(`${API_URL}/scanner/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: walletAddress, coin, dex: '' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast('error', err.detail || 'Failed to add coin');
        return;
      }
      showToast('success', `${coin} added to watchlist`);
      await fetchWatchlist();
    } catch {
      showToast('error', 'Network error — could not add coin');
    }
  };

  // ── Remove coin ──────────────────────────────────────────────────────────
  const handleRemove = async (entry: WatchlistEntry) => {
    try {
      const res = await fetch(
        `${API_URL}/scanner/watchlist/${entry.id}?wallet_address=${encodeURIComponent(walletAddress)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) { showToast('error', 'Failed to remove coin'); return; }
      showToast('success', `${entry.coin} removed`);
      setWatchlist(prev => prev.filter(e => e.id !== entry.id));
    } catch {
      showToast('error', 'Network error — could not remove coin');
    }
  };

  // ── Group signals by coin → timeframe (client-side, no backend change) ──
  // API returns signals ordered most-recent-first; preserve that order here.
  const signalsByCoin: Record<string, Record<string, Signal[]>> = {};
  for (const sig of signals) {
    if (!signalsByCoin[sig.coin]) signalsByCoin[sig.coin] = {};
    if (!signalsByCoin[sig.coin][sig.timeframe]) signalsByCoin[sig.coin][sig.timeframe] = [];
    signalsByCoin[sig.coin][sig.timeframe].push(sig);
  }

  const alreadyAdded = new Set(watchlist.map(e => e.coin));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="p-6" style={{ maxWidth: 1200, margin: '0 auto' }}>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: 20,
            right: 20,
            zIndex: 9999,
            padding: '10px 16px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            background: toast.type === 'success' ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
            border: `1px solid ${toast.type === 'success' ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)'}`,
            color: toast.type === 'success' ? '#10b981' : '#ef4444',
          }}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white mb-1">Technical Scanner</h2>
        <p style={{ color: '#6b7280', fontSize: 13 }}>
          Watches your coins across 15m / 1h / 4h for RSI divergence, EMA crossovers, and Donchian breakouts.
          Scans every 5 minutes. Signals deduplicated over a 4-hour window.
        </p>
      </div>

      {/* ── Add-coin row ──────────────────────────────────────────────────── */}
      <div
        className="rounded-xl p-4 mb-6"
        style={{ backgroundColor: '#0d0d14', border: '1px solid #1a1a2e' }}
      >
        <div className="flex items-center gap-3 mb-2">
          <h3 className="text-sm font-semibold text-white">Add to Watchlist</h3>
          {watchlist.length > 0 && (
            <span style={{ fontSize: 11, color: '#4b5563' }}>
              {watchlist.length} coin{watchlist.length !== 1 ? 's' : ''} monitored
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <CoinAutocomplete
            symbols={symbols}
            symbolsLoading={symbolsLoading}
            alreadyAdded={alreadyAdded}
            onAdd={handleAdd}
          />
        </div>
        {watchlist.length === 0 && !loadingWl && (
          <p style={{ color: '#4b5563', fontSize: 12, marginTop: 8 }}>
            Search and select a coin above — a signal card will appear below for each one.
          </p>
        )}
      </div>

      {/* ── Per-ticker signal cards ───────────────────────────────────────── */}
      <div>
        {/* Section header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Signals by Coin</h3>
          <span style={{ fontSize: 11, color: '#6b7280' }}>Auto-refreshes every 45 s</span>
        </div>

        {loadingWl || loadingSig ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
            Loading…
          </div>
        ) : watchlist.length === 0 ? (
          <div
            className="rounded-xl"
            style={{
              backgroundColor: '#0d0d14',
              border: '1px solid #1a1a2e',
              padding: '40px 24px',
              textAlign: 'center',
              color: '#6b7280',
              fontSize: 13,
            }}
          >
            No coins yet — search and select one above to start scanning.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {watchlist.map(entry => (
              <TickerCard
                key={entry.id}
                entry={entry}
                coinSignals={signalsByCoin[entry.coin] ?? {}}
                onRemove={handleRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
