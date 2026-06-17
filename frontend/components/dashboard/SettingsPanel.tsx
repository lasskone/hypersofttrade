'use client';

import { useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

interface Props {
  walletAddress: string;
  isAffiliated?: boolean;
}

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function SettingsPanel({ walletAddress, isAffiliated = true }: Props) {
  const [privateKey, setPrivateKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!privateKey.trim()) return;
    setSaveStatus('saving');
    setErrorMsg('');
    try {
      const res = await fetch(`${API_URL}/account/save-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: walletAddress, private_key: privateKey }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setSaveStatus('success');
      setPrivateKey('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setSaveStatus('error');
    }
  };

  return (
    <div className="p-6 max-w-xl flex flex-col gap-6">
      {/* API Key section */}
      <section
        className="rounded-xl border p-6"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        <h2 className="text-sm font-semibold text-white mb-1">Hyperliquid API Key</h2>
        <p className="text-xs text-gray-500 mb-5 leading-relaxed">
          Add your Hyperliquid API wallet private key to enable trading and bot execution.
          Your key is encrypted and stored securely.
        </p>

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              placeholder="Private Key (0x...)"
              value={privateKey}
              onChange={e => setPrivateKey(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 pr-10 text-sm text-white outline-none font-mono"
              style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-300"
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>

          {saveStatus === 'success' && (
            <p className="text-xs text-emerald-400">API key saved securely.</p>
          )}
          {saveStatus === 'error' && (
            <p className="text-xs text-red-400">{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={saveStatus === 'saving' || !privateKey.trim()}
            className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-opacity disabled:opacity-40"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            {saveStatus === 'saving' ? 'Saving…' : 'Save API Key'}
          </button>
        </form>
      </section>

      {/* Account info section */}
      <section
        className="rounded-xl border p-6"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        <h2 className="text-sm font-semibold text-white mb-4">Account Info</h2>

        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">Wallet</span>
            <span className="text-xs font-mono text-gray-300">{truncate(walletAddress)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">Affiliation</span>
            {isAffiliated ? (
              <span className="text-xs font-medium text-emerald-400">✓ Affiliated via HyperSoftTrade</span>
            ) : (
              <span className="text-xs text-gray-600">Not affiliated</span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
