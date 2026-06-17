'use client';

import { useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

interface Props {
  walletAddress: string;
  onComplete: () => void;
}

type SubStep = 'instructions' | 'key_input';
type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Progress dots ────────────────────────────────────────────────────────────
function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className="rounded-full transition-all"
          style={{
            width: i === current - 1 ? 20 : 8,
            height: 8,
            backgroundColor: i === current - 1 ? '#00d4aa' : '#1a1a2e',
          }}
        />
      ))}
      <span className="ml-2 text-xs text-gray-600">Step {current} of {total}</span>
    </div>
  );
}

// ─── Sub-step A: Instructions ─────────────────────────────────────────────────
function InstructionsStep({ onNext }: { onNext: () => void }) {
  const steps = [
    'Go to app.hyperliquid.xyz and log in',
    'Click "More" in the top navigation',
    'Select "API" from the dropdown',
    'Click "Generate API Wallet"',
    'Copy the private key (starts with 0x…)',
  ];

  return (
    <>
      <StepDots current={2} total={3} />

      <h2 className="text-xl font-bold text-white mb-2">Connect your Hyperliquid account</h2>
      <p className="text-sm text-gray-400 mb-6">
        Follow these steps to generate your API key on Hyperliquid.
      </p>

      <ol className="flex flex-col gap-3 mb-8">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
              style={{ backgroundColor: '#00d4aa1a', color: '#00d4aa', border: '1px solid #00d4aa33' }}
            >
              {i + 1}
            </span>
            <span className="text-sm text-gray-300 pt-0.5">{step}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3">
        <button
          onClick={onNext}
          className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80"
          style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
        >
          I have my API key →
        </button>
        <a
          href="https://app.hyperliquid.xyz"
          target="_blank"
          rel="noopener noreferrer"
          className="text-center text-xs transition-colors"
          style={{ color: '#6b7280' }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = '#9ca3af')}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = '#6b7280')}
        >
          Open Hyperliquid ↗
        </a>
      </div>
    </>
  );
}

// ─── Sub-step B: Key input ────────────────────────────────────────────────────
function KeyInputStep({
  walletAddress,
  onBack,
  onComplete,
}: {
  walletAddress: string;
  onBack: () => void;
  onComplete: () => void;
}) {
  const [privateKey, setPrivateKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
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
      setTimeout(() => onComplete(), 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setSaveStatus('error');
    }
  };

  return (
    <>
      <StepDots current={3} total={3} />

      <h2 className="text-xl font-bold text-white mb-2">Enter your API private key</h2>
      <p className="text-sm text-gray-400 mb-5">
        Paste the private key you just generated on Hyperliquid.
      </p>

      {/* Security notice */}
      <div
        className="rounded-xl px-4 py-3 mb-6 text-xs leading-relaxed"
        style={{ backgroundColor: '#f59e0b0d', border: '1px solid #f59e0b22', color: '#fbbf24' }}
      >
        🔒 Your key is encrypted with AES-256 before storage. We cannot access your funds directly.
      </div>

      {saveStatus === 'success' ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
            style={{ backgroundColor: '#10b98120', border: '1px solid #10b98144' }}
          >
            ✓
          </div>
          <p className="text-sm font-semibold text-emerald-400">Connected successfully!</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Key input */}
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              placeholder="0x..."
              value={privateKey}
              onChange={e => setPrivateKey(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 pr-12 text-sm text-white outline-none font-mono"
              style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
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

          {/* Wallet display */}
          <p className="text-xs text-gray-600">
            Linking to: <span className="font-mono text-gray-400">{truncate(walletAddress)}</span>
          </p>

          {/* Error */}
          {saveStatus === 'error' && (
            <p className="text-xs text-red-400">{errorMsg}</p>
          )}

          {/* Buttons */}
          <button
            type="submit"
            disabled={saveStatus === 'saving' || !privateKey.trim()}
            className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            {saveStatus === 'saving' ? 'Saving…' : 'Connect & Start Trading →'}
          </button>

          <button
            type="button"
            onClick={onBack}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          >
            ← Back to instructions
          </button>
        </form>
      )}
    </>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function OnboardingFlow({ walletAddress, onComplete }: Props) {
  const [subStep, setSubStep] = useState<SubStep>('instructions');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
      <div
        className="mx-4 w-full max-w-[480px] rounded-2xl border p-8 shadow-2xl"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center font-black text-xl"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            H
          </div>
        </div>

        {subStep === 'instructions' ? (
          <InstructionsStep onNext={() => setSubStep('key_input')} />
        ) : (
          <KeyInputStep
            walletAddress={walletAddress}
            onBack={() => setSubStep('instructions')}
            onComplete={onComplete}
          />
        )}
      </div>
    </div>
  );
}
