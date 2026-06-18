'use client';

import { useDisconnect } from 'wagmi';

interface Props {
  active: string;
  onNavigate: (s: string) => void;
  walletAddress: string;
}

const NAV: { id: string; label: string; icon: string }[] = [
  { id: 'overview',  label: 'Overview',  icon: '📊' },
  { id: 'trade',     label: 'Trade',     icon: '📈' },
  { id: 'bots',      label: 'Bots',      icon: '🤖' },
  { id: 'history',   label: 'History',   icon: '📋' },
  { id: 'settings',  label: 'Settings',  icon: '⚙️' },
];

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function Sidebar({ active, onNavigate, walletAddress }: Props) {
  const { disconnect } = useDisconnect();

  return (
    <aside
      className="fixed top-0 left-0 h-full flex flex-col z-40"
      style={{ width: 240, backgroundColor: '#0d0d14', borderRight: '1px solid #1a1a2e' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-5 py-5 border-b" style={{ borderColor: '#1a1a2e' }}>
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center font-black text-xs flex-shrink-0"
          style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
        >
          H
        </div>
        <span className="font-bold text-sm text-white tracking-tight">HyperSoftTrade</span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 p-3 flex-1">
        {NAV.map(({ id, label, icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left w-full"
              style={{
                backgroundColor: isActive ? '#00d4aa12' : 'transparent',
                color: isActive ? '#00d4aa' : '#9ca3af',
                borderLeft: isActive ? '2px solid #00d4aa' : '2px solid transparent',
              }}
            >
              <span>{icon}</span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Wallet + disconnect */}
      <div className="p-4 border-t" style={{ borderColor: '#1a1a2e' }}>
        <p className="text-xs text-gray-500 font-mono mb-2 truncate">{truncate(walletAddress)}</p>
        <button
          onClick={() => disconnect()}
          className="w-full text-xs text-gray-500 hover:text-red-400 transition-colors text-left"
        >
          Disconnect
        </button>
      </div>
    </aside>
  );
}
