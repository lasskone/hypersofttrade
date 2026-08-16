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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
// CoinAutocomplete — mirrors MarketMultiSelect styling from BotsPanel
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
  const fetchSignals = async () => {
    try {
      const res = await fetch(
        `${API_URL}/scanner/signals?wallet_address=${encodeURIComponent(walletAddress)}&limit=100`
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

  // ── Add coin (called by autocomplete on selection) ───────────────────────
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

  const alreadyAdded = new Set(watchlist.map(e => e.coin));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="p-6" style={{ maxWidth: 960, margin: '0 auto' }}>

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

      {/* ── Watchlist management ─────────────────────────────────────────── */}
      <div
        className="rounded-xl p-5 mb-6"
        style={{ backgroundColor: '#0d0d14', border: '1px solid #1a1a2e' }}
      >
        <h3 className="text-sm font-semibold text-white mb-4">Watchlist</h3>

        {/* Autocomplete add row */}
        <div className="flex gap-2 mb-4">
          <CoinAutocomplete
            symbols={symbols}
            symbolsLoading={symbolsLoading}
            alreadyAdded={alreadyAdded}
            onAdd={handleAdd}
          />
        </div>

        {/* Coin chips */}
        {loadingWl ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Loading watchlist…</p>
        ) : watchlist.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>
            No coins yet — search and select one above to start scanning.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {watchlist.map(entry => (
              <div
                key={entry.id}
                className="flex items-center gap-1.5"
                style={{
                  background: '#00d4aa12',
                  border: '1px solid #00d4aa30',
                  borderRadius: 20,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#00d4aa',
                }}
              >
                <span>{entry.coin}</span>
                <button
                  onClick={() => handleRemove(entry)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#00d4aa80',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: '0 2px',
                  }}
                  title={`Remove ${entry.coin}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Signals feed ────────────────────────────────────────────────── */}
      <div
        className="rounded-xl"
        style={{ backgroundColor: '#0d0d14', border: '1px solid #1a1a2e', overflow: 'hidden' }}
      >
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid #1a1a2e' }}
        >
          <h3 className="text-sm font-semibold text-white">Recent Signals</h3>
          <span style={{ fontSize: 11, color: '#6b7280' }}>Auto-refreshes every 45 s</span>
        </div>

        {loadingSig ? (
          <div className="px-5 py-8 text-center" style={{ color: '#6b7280', fontSize: 13 }}>
            Loading signals…
          </div>
        ) : signals.length === 0 ? (
          <div className="px-5 py-8 text-center" style={{ color: '#6b7280', fontSize: 13 }}>
            No signals yet — most candles are not at a crossover / breakout / divergence.
            Signals appear here as they are detected.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #1a1a2e' }}>
                  {['Coin', 'Timeframe', 'Signal', 'Price', 'When'].map(h => (
                    <th
                      key={h}
                      style={{
                        padding: '10px 16px',
                        textAlign: 'left',
                        fontWeight: 600,
                        fontSize: 11,
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map((sig, i) => {
                  const bullish = isBullish(sig.signal_type);
                  const color   = bullish ? '#10b981' : '#ef4444';
                  return (
                    <tr
                      key={sig.id}
                      style={{
                        borderBottom: i < signals.length - 1 ? '1px solid #0a0a0f' : 'none',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                      }}
                    >
                      <td style={{ padding: '10px 16px', color: '#fff', fontWeight: 600 }}>
                        {sig.coin}
                      </td>
                      <td style={{ padding: '10px 16px', color: '#9ca3af' }}>
                        {sig.timeframe}
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 12,
                            fontSize: 11,
                            fontWeight: 600,
                            background: `${color}18`,
                            border: `1px solid ${color}40`,
                            color,
                          }}
                        >
                          {SIGNAL_LABELS[sig.signal_type] || sig.signal_type}
                        </span>
                      </td>
                      <td style={{ padding: '10px 16px', color: '#9ca3af', fontFamily: 'monospace' }}>
                        {Number(sig.price).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 4,
                        })}
                      </td>
                      <td style={{ padding: '10px 16px', color: '#6b7280' }}>
                        {timeAgo(sig.detected_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
