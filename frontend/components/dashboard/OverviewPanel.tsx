'use client';

const STATS = [
  { label: 'Portfolio Value', value: '$0.00' },
  { label: 'Open Positions',  value: '0' },
  { label: 'Active Bots',     value: '0' },
  { label: 'Total PnL',       value: '$0.00' },
];

export function OverviewPanel() {
  return (
    <div className="p-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        {STATS.map(({ label, value }) => (
          <div
            key={label}
            className="rounded-xl p-5 border group transition-colors"
            style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#00d4aa44')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
          >
            <p className="text-xs text-gray-500 mb-2">{label}</p>
            <p className="text-2xl font-black text-white">{value}</p>
          </div>
        ))}
      </div>

      <div
        className="rounded-xl border px-6 py-4 text-sm text-gray-500"
        style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}
      >
        Connect your Hyperliquid API key in{' '}
        <span style={{ color: '#00d4aa' }}>Settings</span>{' '}
        to see live data.
      </div>
    </div>
  );
}
