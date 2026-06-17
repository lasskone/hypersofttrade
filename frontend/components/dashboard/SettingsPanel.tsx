'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

interface Props {
  walletAddress: string;
}

type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function SettingsPanel({ walletAddress }: Props) {
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiWalletAddress, setApiWalletAddress] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // Fetch current status on mount
  useEffect(() => {
    if (!walletAddress) return;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/account/${walletAddress}/status`);
        if (!res.ok) return;
        const data = await res.json();
        setHasApiKey(data.has_api_key ?? false);
      } catch {
        // Non-blocking — just don't show status
      }
    })();
  }, [walletAddress]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiWalletAddress.trim() || !privateKey.trim()) return;
    setSaveStatus('saving');
    setErrorMsg('');

    try {
      const res = await fetch(`${API_URL}/account/save-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          api_wallet_address: apiWalletAddress,
          private_key: privateKey,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setSaveStatus('success');
      setHasApiKey(true);
      setApiWalletAddress('');
      setPrivateKey('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setSaveStatus('error');
    }
  };

  return (
    <div className="p-6 max-w-xl flex flex-col gap-5">

      {/* Account info */}
      <section
        className="rounded-xl border p-5"
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
            <span className="text-xs font-medium text-emerald-400">✓ Affiliated via HyperSoftTrade</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500">API Key</span>
            {hasApiKey === null ? (
              <span className="text-xs text-gray-600">—</span>
            ) : hasApiKey ? (
              <span className="text-xs font-medium text-emerald-400">✓ API Key connected</span>
            ) : (
              <span className="text-xs font-medium text-red-400">✗ Not connected</span>
            )}
          </div>
        </div>
      </section>

      {/* API Key management */}
      <section
        className="rounded-xl border p-5"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        <h2 className="text-sm font-semibold text-white mb-1">
          {hasApiKey ? 'Update API Key' : 'Add API Key'}
        </h2>
        <p className="text-xs text-gray-500 mb-5 leading-relaxed">
          Your Hyperliquid API wallet address and private key. The private key is encrypted with AES-256 before storage.
        </p>

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          {/* API Wallet Address */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">
              API Wallet Address
            </label>
            <input
              type="text"
              placeholder="0x... (API wallet address provided by Hyperliquid)"
              value={apiWalletAddress}
              onChange={e => setApiWalletAddress(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none font-mono"
              style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
              onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
              onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
            />
          </div>

          {/* Private Key */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">
              Private Key
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                placeholder="0x... (private key provided by Hyperliquid)"
                value={privateKey}
                onChange={e => setPrivateKey(e.target.value)}
                className="w-full rounded-lg px-3 py-2.5 pr-12 text-sm text-white outline-none font-mono"
                style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
                onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-base text-gray-600 hover:text-gray-400 transition-colors"
              >
                {showKey ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          {saveStatus === 'success' && (
            <p className="text-xs text-emerald-400">API key saved successfully.</p>
          )}
          {saveStatus === 'error' && (
            <p className="text-xs text-red-400">{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={saveStatus === 'saving' || !apiWalletAddress.trim() || !privateKey.trim()}
            className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            {saveStatus === 'saving' ? 'Saving…' : hasApiKey ? 'Update API Key' : 'Save API Key'}
          </button>
        </form>
      </section>
    </div>
  );
}
