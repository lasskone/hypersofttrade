'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

interface Position {
  symbol: string;
  size: number;
  entry_price: number;
  mark_price: number;
  unrealized_pnl: number;
  leverage: number;
}

interface Portfolio {
  account_value: number;
  available_margin: number;
  total_pnl: number;
  open_positions: Position[];
}

type Status = 'loading' | 'loaded' | 'no_api_key' | 'no_account' | 'error';

interface Props {
  walletAddress: string;
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SkeletonCard() {
  return (
    <div
      className="rounded-xl p-5 border animate-pulse"
      style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
    >
      <div className="h-3 w-24 rounded mb-3" style={{ backgroundColor: '#1a1a2e' }} />
      <div className="h-7 w-32 rounded" style={{ backgroundColor: '#222236' }} />
    </div>
  );
}

export function OverviewPanel({ walletAddress }: Props) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    if (!walletAddress) return;
    (async () => {
      setStatus('loading');
      try {
        const res = await fetch(`${API_URL}/account/${walletAddress}/portfolio`);
        if (res.status === 404) { setStatus('no_account'); return; }
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

  if (status === 'loading') {
    return (
      <div className="p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  if (status === 'no_api_key') {
    return (
      <div className="p-6">
        <div
          className="rounded-xl border px-6 py-5 text-sm"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}
        >
          <p className="text-gray-400 mb-1 font-medium">No API key connected</p>
          <p className="text-gray-600 text-xs">
            Add your API key in <span style={{ color: '#00d4aa' }}>Settings</span> to see your live portfolio data.
          </p>
        </div>
      </div>
    );
  }

  if (status === 'no_account') {
    return (
      <div className="p-6">
        <div
          className="rounded-xl border px-6 py-5 text-sm text-gray-500"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}
        >
          No trading history found for this wallet.
        </div>
      </div>
    );
  }

  if (status === 'error' || !portfolio) {
    return (
      <div className="p-6">
        <div
          className="rounded-xl border px-6 py-5 text-sm text-red-400"
          style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}
        >
          Could not load portfolio data. Please try again.
        </div>
      </div>
    );
  }

  const { account_value, available_margin, total_pnl, open_positions } = portfolio;
  const pnlPositive = total_pnl >= 0;

  const stats = [
    { label: 'Account Value',    value: `$${fmt(account_value)}`,    color: '#ffffff' },
    { label: 'Available Margin', value: `$${fmt(available_margin)}`, color: '#ffffff' },
    { label: 'Open Positions',   value: String(open_positions.length), color: '#ffffff' },
    {
      label: 'Unrealized PnL',
      value: `${pnlPositive ? '+' : ''}$${fmt(total_pnl)}`,
      color: pnlPositive ? '#10b981' : '#ef4444',
    },
  ];

  return (
    <div className="p-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        {stats.map(({ label, value, color }) => (
          <div
            key={label}
            className="rounded-xl p-5 border transition-colors"
            style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#00d4aa44')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
          >
            <p className="text-xs text-gray-500 mb-2">{label}</p>
            <p className="text-2xl font-black" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Positions table */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}
      >
        <div className="px-5 py-3 border-b" style={{ borderColor: '#1a1a2e' }}>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Open Positions</h2>
        </div>

        {open_positions.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-600">No open positions</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b" style={{ borderColor: '#1a1a2e' }}>
                  {['Symbol', 'Size', 'Entry Price', 'Mark Price', 'PnL', 'Leverage'].map(h => (
                    <th key={h} className="px-5 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open_positions.map((pos, i) => {
                  const pos_positive = pos.unrealized_pnl >= 0;
                  return (
                    <tr
                      key={i}
                      className="border-b last:border-0 hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1a1a2e' }}
                    >
                      <td className="px-5 py-3 font-semibold text-white">{pos.symbol}</td>
                      <td className="px-5 py-3 text-gray-300">{pos.size}</td>
                      <td className="px-5 py-3 text-gray-300">${fmt(pos.entry_price)}</td>
                      <td className="px-5 py-3 text-gray-300">${fmt(pos.mark_price)}</td>
                      <td className="px-5 py-3 font-semibold" style={{ color: pos_positive ? '#10b981' : '#ef4444' }}>
                        {pos_positive ? '+' : ''}${fmt(pos.unrealized_pnl)}
                      </td>
                      <td className="px-5 py-3 text-gray-300">{pos.leverage}x</td>
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
