'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';
const REFERRAL_LINK = 'https://app.hyperliquid.xyz/join/KNS';

interface Props {
  walletAddress: string;
  onVerified: () => void;
}

type GateState = 'checking' | 'not_affiliated' | 'error';

// ─── Progress indicator ───────────────────────────────────────────────────────
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

// ─── API call ────────────────────────────────────────────────────────────────
async function callVerify(walletAddress: string): Promise<{ is_affiliated: boolean }> {
  console.log('[AffiliateGate] verify call for', walletAddress);
  const res = await fetch(`${API_URL}/account/verify-affiliation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: walletAddress }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Component ───────────────────────────────────────────────────────────────
export function AffiliateGate({ walletAddress, onVerified }: Props) {
  const [gateState, setGateState] = useState<GateState>('checking');
  const [verifying, setVerifying] = useState(false);
  const [ctaClicked, setCtaClicked] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'error' | 'info' } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Initial silent check on mount
  useEffect(() => {
    if (!walletAddress) return;
    (async () => {
      try {
        const data = await callVerify(walletAddress);
        console.log('[AffiliateGate] initial check:', data);
        if (data.is_affiliated) {
          onVerified();
        } else {
          setGateState('not_affiliated');
        }
      } catch (err) {
        console.error('[AffiliateGate] initial check failed:', err);
        setGateState('not_affiliated'); // show gate, don't block on network error
      }
    })();
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // Start auto-poll after CTA is clicked
  const handleCtaClick = () => {
    setCtaClicked(true);
    setMessage({ text: 'Waiting for your account to be created…', type: 'info' });
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(async () => {
      try {
        const data = await callVerify(walletAddress);
        if (data.is_affiliated) {
          stopPoll();
          onVerified();
        }
      } catch {
        // ignore poll errors silently
      }
    }, 8000);
  };

  // Manual verify button
  const handleVerify = async () => {
    if (verifying) return;
    setVerifying(true);
    setMessage(null);
    try {
      const data = await callVerify(walletAddress);
      console.log('[AffiliateGate] manual verify:', data);
      if (data.is_affiliated) {
        stopPoll();
        onVerified();
      } else {
        setMessage({
          text: 'Account not linked to HyperSoftTrade. Make sure you used our link.',
          type: 'error',
        });
      }
    } catch (err) {
      console.error('[AffiliateGate] manual verify failed:', err);
      setMessage({ text: 'Server error. Please try again.', type: 'error' });
    } finally {
      setVerifying(false);
    }
  };

  // Full-screen spinner while doing the initial silent check
  if (gateState === 'checking') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
        <div className="flex flex-col items-center gap-4">
          <div
            className="h-7 w-7 animate-spin rounded-full border-2 border-gray-800"
            style={{ borderTopColor: '#00d4aa' }}
          />
          <p className="text-sm text-gray-600">Verifying affiliation…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
      <div
        className="mx-4 w-full max-w-[460px] rounded-2xl border p-8 shadow-2xl"
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

        <StepDots current={1} total={3} />

        <h2 className="text-xl font-bold text-white mb-3">Create your Hyperliquid account</h2>
        <p className="text-sm leading-relaxed text-gray-400 mb-2">
          HyperSoftTrade is 100% free. To get started, create your Hyperliquid account via our
          link — it takes 2 minutes.
        </p>
        <p className="text-xs font-medium mb-6" style={{ color: '#00d4aa' }}>
          This is required to access HyperSoftTrade.
        </p>

        {/* Message banner */}
        {message && (
          <div
            className="mb-5 rounded-lg px-4 py-2.5 text-xs leading-relaxed"
            style={{
              backgroundColor: message.type === 'error' ? '#ef44440f' : '#00d4aa0f',
              color: message.type === 'error' ? '#f87171' : '#00d4aa',
            }}
          >
            {message.text}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {/* Primary CTA */}
          <a
            href={REFERRAL_LINK}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleCtaClick}
            className="flex items-center justify-center rounded-xl py-3 text-sm font-semibold transition-opacity hover:opacity-80"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            {ctaClicked ? 'Waiting… Click below when done' : 'Create Account (Free) →'}
          </a>

          {/* Divider */}
          <div className="flex items-center gap-3 my-1">
            <div className="flex-1 h-px" style={{ backgroundColor: '#1a1a2e' }} />
            <span className="text-xs text-gray-600">already have an account?</span>
            <div className="flex-1 h-px" style={{ backgroundColor: '#1a1a2e' }} />
          </div>

          {/* Verify button */}
          <button
            onClick={handleVerify}
            disabled={verifying}
            className="rounded-xl border py-3 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ borderColor: '#1a1a2e', color: '#9ca3af' }}
            onMouseEnter={e => !verifying && ((e.currentTarget as HTMLElement).style.borderColor = '#374151')}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.borderColor = '#1a1a2e')}
          >
            {verifying ? 'Verifying…' : 'I already have an account → Verify'}
          </button>
        </div>
      </div>
    </div>
  );
}
