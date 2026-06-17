'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

const PAGE_TITLES: Record<string, string> = {
  overview: 'Overview',
  trade:    'Trade',
  bots:     'Bots',
  history:  'History',
  settings: 'Settings',
};

interface Props {
  section: string;
}

export function TopBar({ section }: Props) {
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const res = await fetch(`${API_URL}/market/prices`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const price = parseFloat(data.prices?.BTC);
        if (!isNaN(price)) {
          setBtcPrice(price);
          setOnline(true);
        }
      } catch {
        setOnline(false);
      }
    };

    fetchPrice();
    const id = setInterval(fetchPrice, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <header
      className="flex items-center justify-between px-6 py-4 border-b"
      style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}
    >
      <h1 className="text-sm font-semibold text-white">{PAGE_TITLES[section] ?? section}</h1>

      <div className="flex items-center gap-3">
        <span className="font-mono text-sm text-gray-300">
          {btcPrice !== null ? `BTC $${btcPrice.toLocaleString()}` : 'BTC —'}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full animate-pulse"
            style={{ backgroundColor: online ? '#10b981' : '#ef4444' }}
          />
          <span className="text-xs text-gray-500">{online ? 'Live' : 'Offline'}</span>
        </div>
      </div>
    </header>
  );
}
