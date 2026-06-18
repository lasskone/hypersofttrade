'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

// ─── Safe formatters ──────────────────────────────────────────────────────────
const fmt = (val: unknown, decimals = 2): string => {
  const n = parseFloat(String(val ?? 0));
  if (isNaN(n)) return '0.00';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

const fmtPnl = (val: unknown): string => {
  const n = parseFloat(String(val ?? 0));
  if (isNaN(n)) return '+$0.00';
  return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const fmtTime = (val: unknown): string => {
  const ms = parseInt(String(val ?? 0));
  if (!ms || isNaN(ms)) return '—';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const isBuySide = (side: unknown): boolean => {
  const s = String(side ?? '').toUpperCase();
  return s === 'B' || s === 'BUY';
};

// ─── Sub-components ───────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="rounded-xl p-5 border animate-pulse"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
      <div className="h-3 w-24 rounded mb-3" style={{ backgroundColor: '#1a1a2e' }} />
      <div className="h-7 w-32 rounded" style={{ backgroundColor: '#222236' }} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border overflow-hidden mb-4"
      style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
      <div className="px-5 py-3 border-b" style={{ borderColor: '#1a1a2e' }}>
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function TH({ children }: { children: React.ReactNode }) {
  return <th className="px-5 py-3 text-left font-medium text-xs text-gray-500">{children}</th>;
}

function TD({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <td className="px-5 py-3 text-sm text-gray-300" style={color ? { color } : undefined}>
      {children}
    </td>
  );
}

function LiveDot() {
  return (
    <span style={{
      display: 'inline-block',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: '#00d4aa',
      marginLeft: '6px',
      animation: 'pulse 2s infinite',
      verticalAlign: 'middle',
    }} />
  );
}

// ─── Position management modal ───────────────────────────────────────────────
function PositionModal({ pos, walletAddress, onClose, onAction }: {
  pos: any;
  walletAddress: string;
  onClose: () => void;
  onAction: () => void;
}) {
  const [closePercent, setClosePercent] = useState(100);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [tpSlLoading, setTpSlLoading] = useState(false);

  const isLong = parseFloat(pos.size) > 0;
  const absSize = Math.abs(parseFloat(pos.size));
  const markPrice = parseFloat(pos.mark_price ?? pos.entry_price ?? 0);
  const upnl = parseFloat(pos.unrealized_pnl ?? 0);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const handleClose = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/orders/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: pos.symbol,
          is_long: isLong,
          size: absSize,
          sz_decimals: pos.sz_decimals ?? 5,
          percentage: closePercent,
          mark_price: markPrice,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? 'Error');
      showToast(`✅ Position closed (${closePercent}%)`);
      setTimeout(onAction, 1500);
    } catch (e: any) {
      showToast(`❌ ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSetTpSl = async () => {
    const tpVal = parseFloat(tpPrice)
    const slVal = parseFloat(slPrice)
    if (!tpVal && !slVal) return
    setTpSlLoading(true)
    try {
      const res = await fetch(`${API_URL}/orders/tp-sl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          coin: pos.symbol,
          is_long: isLong,
          size: absSize,
          sz_decimals: pos.sz_decimals ?? 5,
          tp_price: tpVal > 0 ? tpVal : null,
          sl_price: slVal > 0 ? slVal : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? 'Error')
      const msg = [tpVal > 0 ? `TP: $${tpVal}` : '', slVal > 0 ? `SL: $${slVal}` : ''].filter(Boolean).join(' | ')
      showToast(`✅ Set ${msg}`)
      setTpPrice('')
      setSlPrice('')
    } catch (e: any) {
      showToast(`❌ ${e.message}`)
    } finally {
      setTpSlLoading(false)
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}>
      <div
        className="relative w-full max-w-md rounded-2xl border p-6 shadow-2xl"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        onClick={e => e.stopPropagation()}>

        {/* Toast */}
        {toast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 text-xs px-4 py-2 rounded-lg font-medium z-10"
            style={{ backgroundColor: '#1a1a2e', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
            {toast}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-white">{pos.symbol}</h2>
            <span className="text-xs px-2 py-0.5 rounded font-semibold"
              style={{ backgroundColor: isLong ? '#00d4aa18' : '#ef444418', color: isLong ? '#00d4aa' : '#ef4444' }}>
              {isLong ? 'LONG' : 'SHORT'}
            </span>
            <span className="text-xs px-2 py-0.5 rounded font-medium"
              style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
              {pos.dex}
            </span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Position summary */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { label: 'Size', value: `${absSize}` },
            { label: 'Entry Price', value: `$${fmt(pos.entry_price)}` },
            { label: 'Unrealized PnL', value: `${upnl >= 0 ? '+' : ''}$${fmt(upnl)}`, color: upnl >= 0 ? '#10b981' : '#ef4444' },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-lg p-3 text-center" style={{ backgroundColor: '#13131f' }}>
              <p className="text-xs text-gray-500 mb-1">{label}</p>
              <p className="text-sm font-bold" style={{ color: color ?? '#fff' }}>{value}</p>
            </div>
          ))}
        </div>

        {/* Close Position */}
        <div className="rounded-xl p-4 mb-4" style={{ backgroundColor: '#13131f', border: '1px solid #1a1a2e' }}>
          <p className="text-sm font-semibold text-white mb-3">Close Position</p>

          {/* Percentage presets */}
          <div className="flex gap-2 mb-3">
            {[25, 50, 75, 100].map(p => (
              <button
                key={p}
                onClick={() => setClosePercent(p)}
                className="flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all"
                style={{
                  backgroundColor: closePercent === p ? '#00d4aa' : '#1a1a2e',
                  color: closePercent === p ? '#000' : '#9ca3af',
                  border: '1px solid #1a1a2e',
                }}>
                {p}%
              </button>
            ))}
          </div>

          {/* Close summary */}
          <p className="text-xs text-gray-500 mb-3">
            Closing {closePercent}% → {fmt(absSize * closePercent / 100, 5)} {pos.symbol?.replace('-USD', '')} at market
          </p>

          <button
            onClick={handleClose}
            disabled={loading}
            className="w-full py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{ backgroundColor: '#ef4444', color: '#fff' }}>
            {loading ? 'Processing...' : `Close ${closePercent}% of Position`}
          </button>
        </div>

        {/* TP / SL */}
        <div className="rounded-xl p-4 mb-4" style={{ backgroundColor: '#13131f', border: '1px solid #1a1a2e' }}>
          <p className="text-sm font-semibold text-white mb-3">Take Profit / Stop Loss</p>
          <div className="flex gap-2 mb-3">
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>Take Profit (USD)</p>
              <input
                type="number"
                placeholder="TP Price"
                value={tpPrice}
                onChange={e => setTpPrice(e.target.value)}
                style={{ width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#10b981', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>Stop Loss (USD)</p>
              <input
                type="number"
                placeholder="SL Price"
                value={slPrice}
                onChange={e => setSlPrice(e.target.value)}
                style={{ width: '100%', background: '#0d0d14', border: '1px solid #1a1a2e', borderRadius: 6, padding: '6px 10px', color: '#ef4444', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <button
            onClick={handleSetTpSl}
            disabled={tpSlLoading || (!parseFloat(tpPrice) && !parseFloat(slPrice))}
            className="w-full py-2.5 rounded-lg text-sm font-bold transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{ backgroundColor: '#00d4aa', color: '#000' }}>
            {tpSlLoading ? 'Setting...' : 'Set TP / SL'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function OverviewPanel({
  walletAddress,
  onNavigate,
}: {
  walletAddress: string;
  onNavigate?: (section: string) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<'loading' | 'no_api_key' | 'error' | 'loaded'>('loading');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [managingPos, setManagingPos] = useState<any>(null);

  // ── Fetch portfolio (extracted so it can be called from onAction) ─────────────
  const fetchPortfolio = async () => {
    if (!walletAddress) return;
    setStatus('loading');
    setData(null);
    try {
      const res = await fetch(`${API_URL}/account/${walletAddress}/portfolio`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json?.error === 'no_api_key') { setStatus('no_api_key'); return; }
      setData(json);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  };

  // ── Initial load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchPortfolio();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // ── Live PnL polling (every 10s) ─────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'loaded' || !walletAddress) return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/account/${walletAddress}/portfolio`);
        if (!res.ok) return;
        const json = await res.json();
        if (json?.error) return;
        setData((prev: any) => ({
          ...prev,
          unrealized_pnl:  json.unrealized_pnl,
          open_positions:  json.open_positions,
          open_positions_count: json.open_positions_count,
          account_value:   json.account_value,
          usdc_spot_balance: json.usdc_spot_balance,
        }));
      } catch {
        // silently ignore poll errors
      }
    }, 10_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status, walletAddress]);

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (status === 'loading' || data === null) {
    return (
      <div className="p-6">
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }
        `}</style>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
          {[0, 1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
        <div className="rounded-xl border animate-pulse h-40"
          style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }} />
      </div>
    );
  }

  // ── No API key ───────────────────────────────────────────────────────────────
  if (status === 'no_api_key') {
    return (
      <div className="p-6">
        <div className="rounded-xl border px-6 py-5"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
          <p className="text-sm font-medium text-gray-400 mb-1">No API key connected</p>
          <p className="text-xs text-gray-600">
            Add your API key in <span style={{ color: '#00d4aa' }}>Settings</span> to see live portfolio data.
          </p>
        </div>
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="p-6">
        <div className="rounded-xl border px-6 py-5 text-sm text-red-400"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
          Could not load portfolio data. Please try again.
        </div>
      </div>
    );
  }

  // ── Loaded — safely destructure with defaults ─────────────────────────────────
  const accountValue     = data?.account_value ?? 0;
  const unrealizedPnl    = data?.unrealized_pnl ?? 0;
  const usdcSpot         = data?.usdc_spot_balance ?? 0;
  const openPositions    = data?.open_positions ?? [];
  const openPositionsCnt = data?.open_positions_count ?? openPositions.length;
  const spotBalances     = data?.spot_balances ?? [];
  const recentFills      = data?.recent_fills ?? [];
  const openOrders       = data?.open_orders ?? [];

  const pnlPos = parseFloat(String(unrealizedPnl)) >= 0;

  const stats = [
    {
      label: 'Account Value',
      subtitle: 'Perp margin + USDC spot',
      value: `$${fmt(accountValue)}`,
      color: '#ffffff',
      live: false,
    },
    {
      label: 'Available USDC',
      subtitle: 'Spot wallet balance',
      value: `$${fmt(usdcSpot)}`,
      color: '#ffffff',
      live: false,
    },
    {
      label: 'Open Positions',
      subtitle: 'Active trades currently running',
      value: String(openPositionsCnt),
      color: '#ffffff',
      live: false,
    },
    {
      label: 'Unrealized PnL',
      subtitle: 'Updates every 10s',
      value: fmtPnl(unrealizedPnl),
      color: pnlPos ? '#10b981' : '#ef4444',
      live: true,
    },
  ];

  return (
    <div className="p-6">
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {stats.map(({ label, subtitle, value, color, live }) => (
          <div key={label} className="rounded-xl p-5 border transition-colors"
            style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#00d4aa44')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#1a1a2e')}>
            <div className="flex items-center mb-1">
              <p className="text-xs text-gray-500">{label}</p>
              {live && <LiveDot />}
            </div>
            <p style={{ fontSize: 11, color: '#6b7280', marginTop: 2, marginBottom: 8 }}>{subtitle}</p>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Open Positions */}
      <Section title="Open Positions">
        {openPositions.length === 0 ? (
          <div className="px-5 py-8 flex flex-col items-center gap-3">
            <p className="text-sm text-gray-600">No open positions — Start trading in the Trade tab</p>
            {onNavigate && (
              <button
                onClick={() => onNavigate('trade')}
                className="text-sm font-semibold px-4 py-2 rounded-lg transition-opacity hover:opacity-80"
                style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
                Go to Trade →
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>DEX</TH><TH>Symbol</TH><TH>Size</TH><TH>Entry Price</TH>
                  <TH>Position Value</TH><TH>PnL</TH><TH>Leverage</TH><TH>Liq. Price</TH><TH>Actions</TH>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((pos: any, i: number) => {
                  const upnl   = parseFloat(String(pos?.unrealized_pnl ?? 0));
                  const posPos = upnl >= 0;
                  const liqPx  = parseFloat(String(pos?.liquidation_price ?? 0));
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3">
                        <span className="text-xs px-2 py-0.5 rounded font-medium"
                          style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
                          {pos?.dex ?? '—'}
                        </span>
                      </td>
                      <TD><span className="font-semibold text-white">{pos?.symbol ?? '—'}</span></TD>
                      <TD>{fmt(pos?.size, 4)}</TD>
                      <TD>${fmt(pos?.entry_price)}</TD>
                      <TD>${fmt(pos?.position_value)}</TD>
                      <TD color={posPos ? '#10b981' : '#ef4444'}>{fmtPnl(upnl)}</TD>
                      <TD>{fmt(pos?.leverage, 0)}x {pos?.leverage_type ?? ''}</TD>
                      <TD>{liqPx > 0 ? `$${fmt(liqPx)}` : '—'}</TD>
                      <td className="px-5 py-3">
                        <button
                          onClick={() => setManagingPos(pos)}
                          className="text-xs font-semibold px-3 py-1 rounded-lg transition-opacity hover:opacity-80"
                          style={{ backgroundColor: '#00d4aa18', color: '#00d4aa', border: '1px solid #00d4aa44' }}>
                          Manage
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Open Orders */}
      {openOrders.length > 0 && (
        <Section title="Open Orders">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Coin</TH><TH>Side</TH><TH>Price</TH><TH>Size</TH>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((o: any, i: number) => {
                  const buy = isBuySide(o?.side);
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3 font-semibold text-white text-sm">{o?.coin ?? '—'}</td>
                      <TD color={buy ? '#10b981' : '#ef4444'}>{buy ? 'Buy' : 'Sell'}</TD>
                      <TD>${fmt(o?.price)}</TD>
                      <TD>{fmt(o?.size, 4)}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Spot Balances */}
      {spotBalances.length > 0 && (
        <Section title="Spot Balances">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Coin</TH><TH>Total</TH><TH>Hold</TH>
                </tr>
              </thead>
              <tbody>
                {spotBalances.map((b: any, i: number) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                    style={{ borderColor: '#1a1a2e' }}>
                    <td className="px-5 py-3 font-semibold text-white text-sm">{b?.coin ?? '—'}</td>
                    <TD>{fmt(b?.total, 6)}</TD>
                    <TD>{parseFloat(String(b?.hold ?? 0)) > 0 ? fmt(b?.hold, 6) : '—'}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Recent Trades */}
      {recentFills.length > 0 && (
        <Section title="Recent Trades">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Coin</TH><TH>Side</TH><TH>Price</TH><TH>Size</TH>
                  <TH>Closed PnL</TH><TH>Fee</TH><TH>Time</TH>
                </tr>
              </thead>
              <tbody>
                {recentFills.slice(0, 10).map((f: any, i: number) => {
                  const buy     = isBuySide(f?.side);
                  const cpnl    = parseFloat(String(f?.closed_pnl ?? 0));
                  const cpnlPos = cpnl >= 0;
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3 font-semibold text-white text-sm">{f?.coin ?? '—'}</td>
                      <TD color={buy ? '#10b981' : '#ef4444'}>{buy ? 'Buy' : 'Sell'}</TD>
                      <TD>${fmt(f?.price)}</TD>
                      <TD>{fmt(f?.size, 4)}</TD>
                      <TD color={cpnl !== 0 ? (cpnlPos ? '#10b981' : '#ef4444') : undefined}>
                        {cpnl !== 0 ? fmtPnl(cpnl) : '—'}
                      </TD>
                      <TD color="#6b7280">${fmt(f?.fee)}</TD>
                      <TD color="#6b7280">{fmtTime(f?.time)}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {managingPos && (
        <PositionModal
          pos={managingPos}
          walletAddress={walletAddress}
          onClose={() => setManagingPos(null)}
          onAction={() => { setManagingPos(null); fetchPortfolio(); }}
        />
      )}
    </div>
  );
}
