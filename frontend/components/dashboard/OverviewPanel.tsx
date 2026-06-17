'use client';

import { useEffect, useState } from 'react';

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

// ─── Main component ───────────────────────────────────────────────────────────
export function OverviewPanel({ walletAddress }: { walletAddress: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<'loading' | 'no_api_key' | 'error' | 'loaded'>('loading');

  useEffect(() => {
    if (!walletAddress) return;
    setStatus('loading');
    setData(null);
    (async () => {
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
    })();
  }, [walletAddress]);

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (status === 'loading' || data === null) {
    return (
      <div className="p-6">
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
  const openPositions    = data?.open_positions ?? [];
  const openPositionsCnt = data?.open_positions_count ?? openPositions.length;
  const spotBalances     = data?.spot_balances ?? [];
  const recentFills      = data?.recent_fills ?? [];
  const openOrders       = data?.open_orders ?? [];

  const pnlPos = parseFloat(String(unrealizedPnl)) >= 0;

  const stats = [
    { label: 'Account Value',  value: `$${fmt(accountValue)}`,    color: '#ffffff' },
    { label: 'Unrealized PnL', value: fmtPnl(unrealizedPnl),      color: pnlPos ? '#10b981' : '#ef4444' },
    { label: 'Open Positions', value: String(openPositionsCnt),   color: '#ffffff' },
    { label: 'Open Orders',    value: String(openOrders.length),  color: '#ffffff' },
  ];

  return (
    <div className="p-6">

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {stats.map(({ label, value, color }) => (
          <div key={label} className="rounded-xl p-5 border transition-colors"
            style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#00d4aa44')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#1a1a2e')}>
            <p className="text-xs text-gray-500 mb-2">{label}</p>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Open Positions */}
      <Section title="Open Positions">
        {openPositions.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-600">No open positions</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>DEX</TH><TH>Symbol</TH><TH>Size</TH><TH>Entry Price</TH>
                  <TH>Position Value</TH><TH>PnL</TH><TH>Leverage</TH><TH>Liq. Price</TH>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((pos: any, i: number) => {
                  const upnl    = parseFloat(String(pos?.unrealized_pnl ?? 0));
                  const posPos  = upnl >= 0;
                  const liqPx   = parseFloat(String(pos?.liquidation_price ?? 0));
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

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
                  const buy       = isBuySide(f?.side);
                  const cpnl      = parseFloat(String(f?.closed_pnl ?? 0));
                  const cpnlPos   = cpnl >= 0;
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

    </div>
  );
}
