'use client';

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
  return (
    <header
      className="flex items-center justify-between px-6 py-4 border-b"
      style={{ borderColor: '#1a1a2e', backgroundColor: '#0d0d14' }}
    >
      <h1 className="text-sm font-semibold text-white">{PAGE_TITLES[section] ?? section}</h1>

      <div className="flex items-center gap-3">
        <span className="font-mono text-sm text-gray-300">$00,000</span>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs text-gray-500">Live</span>
        </div>
      </div>
    </header>
  );
}
