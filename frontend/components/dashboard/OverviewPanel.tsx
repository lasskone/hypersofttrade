'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Position {
  dex: string;
  symbol: string;
  size: number;
  entry_price: number;
  position_value: number;
  unrealized_pnl: number;
  leverage: number;
  leverage_type: string;
  liquidation_price: number;
}

interface SpotBalance {
  coin: string;
  total: number;
  hold: number;
}

interface Fill {
  coin: string;
  side: string;
  price: number;
  size: number;
  closed_pnl: number;
  fee: number;
  time: number;
  order_type: string;
}

interface OpenOrder {
  coin: string;
  side: string;
  price: number;
  size: number;
  order_id: string;
}

interface Portfolio {
  wallet_address: string;
  account_value: number;
  unrealized_pnl: number;
  open_positions: Position[];
  open_positions_count: number;
  spot_balances: SpotBalance[];
  recent_fills: Fill[];
  open_orders: OpenOrder[];
  dexes_queried: string[];
}

type Status = 'loading' | 'loaded' | 'no_api_key' | 'error';

interface Props {
  walletAddress: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="rounded-xl p-5 border animate-pulse"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}>
      <div className="h-3 w-24 rounded mb-3" style={{ backgroundColor: '#1a1a2e' }} />
      <div className="h-7 w-32 rounded" style={{ backgroundColor: '#222236' }} />
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────
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

// ─── Table helpers ────────────────────────────────────────────────────────────
function TH({ children }: { children: React.ReactNode }) {
  return <th className="px-5 py-3 text-left font-medium text-xs text-gray-500">{children}</th>;
}
function TD({ children, color }: { children: React.ReactNode; color?: string }) {
  return <td className="px-5 py-3 text-sm text-gray-300" style={color ? { color } : undefined}>{children}</td>;
}

// ─── Main component ───────────────────────────────────────────────────────────
export function OverviewPanel({ walletAddress }: Props) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    if (!walletAddress) return;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(`${API_URL}/account/${walletAddress}/portfolio`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error === 'no_api_key') { setStatus('no_api_key'); return; }
        setPortfolio(data);
        setStatus('loaded');
      } catch {
        setStatus('error');
      }
    })();
  }, [walletAddress]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (status === 'loading') {
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

  // ── No API key ─────────────────────────────────────────────────────────────
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

  // ── Error ──────────────────────────────────────────────────────────────────
  if (status === 'error' || !portfolio) {
    return (
      <div className="p-6">
        <div className="rounded-xl border px-6 py-5 text-sm text-red-400"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}>
          Could not load portfolio data. Please try again.
        </div>
      </div>
    );
  }

  const { account_value, unrealized_pnl, open_positions, open_positions_count,
          spot_balances, recent_fills, open_orders } = portfolio;
  const pnlPos = unrealized_pnl >= 0;

  const stats = [
    { label: 'Account Value',   value: `$${fmt(account_value)}`,                             color: '#ffffff' },
    { label: 'Unrealized PnL',  value: `${pnlPos ? '+' : ''}$${fmt(unrealized_pnl)}`,        color: pnlPos ? '#10b981' : '#ef4444' },
    { label: 'Open Positions',  value: String(open_positions_count),                          color: '#ffffff' },
    { label: 'Open Orders',     value: String(open_orders.length),                            color: '#ffffff' },
  ];

  return (
    <div className="p-6">

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
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

      {/* ── Open Positions ─────────────────────────────────────────────────── */}
      <Section title="Open Positions">
        {open_positions.length === 0 ? (
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
                {open_positions.map((pos, i) => {
                  const pos_pos = pos.unrealized_pnl >= 0;
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3">
                        <span className="text-xs px-2 py-0.5 rounded font-medium"
                          style={{ backgroundColor: '#00d4aa18', color: '#00d4aa' }}>
                          {pos.dex}
                        </span>
                      </td>
                      <TD><span className="font-semibold text-white">{pos.symbol}</span></TD>
                      <TD>{pos.size}</TD>
                      <TD>${fmt(pos.entry_price)}</TD>
                      <TD>${fmt(pos.position_value)}</TD>
                      <TD color={pos_pos ? '#10b981' : '#ef4444'}>
                        {pos_pos ? '+' : ''}${fmt(pos.unrealized_pnl)}
                      </TD>
                      <TD>{pos.leverage}x {pos.leverage_type}</TD>
                      <TD>{pos.liquidation_price > 0 ? `$${fmt(pos.liquidation_price)}` : '—'}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Spot Balances ──────────────────────────────────────────────────── */}
      {spot_balances.length > 0 && (
        <Section title="Spot Balances">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Coin</TH><TH>Total</TH><TH>Hold</TH>
                </tr>
              </thead>
              <tbody>
                {spot_balances.map((b, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                    style={{ borderColor: '#1a1a2e' }}>
                    <td className="px-5 py-3 font-semibold text-white text-sm">{b.coin}</td>
                    <TD>{b.total.toLocaleString('en-US', { maximumFractionDigits: 6 })}</TD>
                    <TD>{b.hold > 0 ? b.hold.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ── Open Orders ────────────────────────────────────────────────────── */}
      {open_orders.length > 0 && (
        <Section title="Open Orders">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1a1a2e' }}>
                  <TH>Coin</TH><TH>Side</TH><TH>Price</TH><TH>Size</TH>
                </tr>
              </thead>
              <tbody>
                {open_orders.map((o, i) => {
                  const isBuy = o.side.toUpperCase() === 'B' || o.side.toLowerCase() === 'buy';
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3 font-semibold text-white text-sm">{o.coin}</td>
                      <TD color={isBuy ? '#10b981' : '#ef4444'}>{isBuy ? 'Buy' : 'Sell'}</TD>
                      <TD>${fmt(o.price)}</TD>
                      <TD>{o.size}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ── Recent Trades ──────────────────────────────────────────────────── */}
      {recent_fills.length > 0 && (
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
                {recent_fills.slice(0, 10).map((f, i) => {
                  const isBuy   = f.side.toUpperCase() === 'B' || f.side.toLowerCase() === 'buy';
                  const pnlPos2 = f.closed_pnl >= 0;
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}>
                      <td className="px-5 py-3 font-semibold text-white text-sm">{f.coin}</td>
                      <TD color={isBuy ? '#10b981' : '#ef4444'}>{isBuy ? 'Buy' : 'Sell'}</TD>
                      <TD>${fmt(f.price)}</TD>
                      <TD>{f.size}</TD>
                      <TD color={f.closed_pnl !== 0 ? (pnlPos2 ? '#10b981' : '#ef4444') : undefined}>
                        {f.closed_pnl !== 0 ? `${pnlPos2 ? '+' : ''}$${fmt(f.closed_pnl)}` : '—'}
                      </TD>
                      <TD color="#6b7280">${fmt(f.fee)}</TD>
                      <TD color="#6b7280">{fmtTime(f.time)}</TD>
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
