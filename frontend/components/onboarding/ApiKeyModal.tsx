'use client';

import { useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

interface Props {
  walletAddress: string;
  onComplete: () => void;
}

type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const STEPS = [
  'Go to app.hyperliquid.xyz and sign in',
  'Click "More" in the top navigation',
  'Select "API" from the dropdown',
  'Click "Generate API Wallet"',
  'Copy the API Wallet Address and the Private Key shown',
];

export function ApiKeyModal({ walletAddress, onComplete }: Props) {
  const [apiWalletAddress, setApiWalletAddress] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
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
      setTimeout(() => onComplete(), 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setSaveStatus('error');
    }
  };

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto py-8"
        style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
      >
        <div
          className="mx-4 w-full max-w-[480px] rounded-2xl border p-8 shadow-2xl"
          style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
        >
          {/* Lock icon + title */}
          <div className="flex flex-col items-center mb-6">
            <span className="text-4xl mb-3">🔒</span>
            <h2 className="text-xl font-bold text-white">One last step</h2>
            <p className="text-sm text-gray-400 text-center mt-2 leading-relaxed">
              Connect your Hyperliquid API to start trading and deploy bots.
            </p>
          </div>

          {/* Instructions */}
          <div
            className="rounded-xl p-4 mb-5"
            style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
          >
            <ol className="flex flex-col gap-2.5">
              {STEPS.map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold mt-0.5"
                    style={{ backgroundColor: '#00d4aa1a', color: '#00d4aa', border: '1px solid #00d4aa33' }}
                  >
                    {i + 1}
                  </span>
                  <span className="text-xs text-gray-300 leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
            <a
              href="https://app.hyperliquid.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-4 text-xs transition-opacity hover:opacity-70"
              style={{ color: '#00d4aa' }}
            >
              Open Hyperliquid API Settings ↗
            </a>
          </div>

          {saveStatus === 'success' ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                style={{ backgroundColor: '#10b98120', border: '1px solid #10b98144' }}
              >
                ✓
              </div>
              <p className="text-sm font-semibold text-emerald-400">
                Connected! Loading your dashboard…
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                  className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none font-mono transition-colors"
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
                    className="w-full rounded-lg px-3 py-2.5 pr-12 text-sm text-white outline-none font-mono transition-colors"
                    style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
                    onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                    onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-base text-gray-600 hover:text-gray-400 transition-colors"
                    title={showKey ? 'Hide key' : 'Show key'}
                  >
                    {showKey ? '🙈' : '👁'}
                  </button>
                </div>
              </div>

              {/* Warning box */}
              <div
                className="rounded-lg px-4 py-3 text-xs leading-relaxed"
                style={{
                  backgroundColor: 'rgba(245,158,11,0.1)',
                  border: '1px solid rgba(245,158,11,0.3)',
                  color: '#fbbf24',
                }}
              >
                🔒 Your private key is encrypted with AES-256. We store it securely and never have direct access to your funds.
              </div>

              {/* Error */}
              {saveStatus === 'error' && (
                <p className="text-xs text-red-400">{errorMsg}</p>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={saveStatus === 'saving' || !apiWalletAddress.trim() || !privateKey.trim()}
                className="w-full py-3 rounded-xl text-sm font-bold transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
              >
                {saveStatus === 'saving' ? 'Saving securely…' : 'Connect & Start Trading →'}
              </button>

              {/* Wallet info */}
              <p className="text-center text-xs" style={{ color: '#6b7280' }}>
                Connecting wallet: <span className="font-mono">{truncate(walletAddress)}</span>
              </p>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
