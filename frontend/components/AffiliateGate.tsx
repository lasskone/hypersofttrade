'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';
const REFERRAL_LINK = 'https://app.hyperliquid.xyz/join/KNS';

interface Props {
  walletAddress: string;
  onVerified: () => void;
}

// Gate state — drives which screen is shown
type GateState = 'idle' | 'checking' | 'affiliated' | 'not_affiliated' | 'error';

async function callVerify(walletAddress: string): Promise<{ is_affiliated: boolean }> {
  console.log('[AffiliateGate] calling verify-affiliation for', walletAddress);
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

export function AffiliateGate({ walletAddress, onVerified }: Props) {
  const [gateState, setGateState] = useState<GateState>('idle');
  // Separate loading flag for the "Verify now" button — keeps gate screen visible
  const [verifying, setVerifying] = useState(false);
  // Distinct messages for not_affiliated vs error on button retry
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  // ── Initial check on mount ─────────────────────────────────────────────────
  useEffect(() => {
    if (!walletAddress) return;
    (async () => {
      setGateState('checking');
      try {
        const data = await callVerify(walletAddress);
        console.log('[AffiliateGate] initial check result:', data);
        if (data.is_affiliated) {
          setGateState('affiliated');
          onVerified();
        } else {
          setGateState('not_affiliated');
        }
      } catch (err) {
        console.error('[AffiliateGate] initial check failed:', err);
        setGateState('error');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  // ── Button-triggered re-verify (stays on gate screen) ────────────────────
  const handleVerifyClick = async () => {
    if (verifying) return;
    setVerifying(true);
    setVerifyMessage(null);
    console.log('[AffiliateGate] manual verify triggered');
    try {
      const data = await callVerify(walletAddress);
      console.log('[AffiliateGate] manual verify result:', data);
      if (data.is_affiliated) {
        setGateState('affiliated');
        onVerified();
      } else {
        setGateState('not_affiliated');
        setVerifyMessage(
          "Account not found with our referral link. Make sure you signed up via our link, then try again."
        );
      }
    } catch (err) {
      console.error('[AffiliateGate] manual verify failed:', err);
      setVerifyMessage('Could not reach server. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  // ── Full-screen spinner — initial load only ───────────────────────────────
  if (gateState === 'checking' || gateState === 'idle') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-4 text-gray-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-emerald-500" />
          <p className="text-sm">Verifying affiliation…</p>
        </div>
      </div>
    );
  }

  // ── Passes through — parent renders dashboard ─────────────────────────────
  if (gateState === 'affiliated') {
    return null;
  }

  // ── Gate screen (not_affiliated or error on initial check) ────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/95 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center shadow-2xl">
        {/* Logo */}
        <div className="mb-6 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-500/10">
            <span className="text-3xl font-black text-emerald-400">H</span>
          </div>
        </div>

        <h2 className="mb-3 text-2xl font-bold text-gray-100">One last step</h2>
        <p className="mb-8 text-sm leading-relaxed text-gray-400">
          To access HyperSoftTrade, create your Hyperliquid account through our
          link. It&apos;s free.
        </p>

        {/* Initial network error banner */}
        {gateState === 'error' && !verifyMessage && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-4 py-2 text-xs text-red-400">
            Could not reach the verification server. Please try again.
          </p>
        )}

        {/* Result message from button-triggered verify */}
        {verifyMessage && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-4 py-2 text-xs text-red-400">
            {verifyMessage}
          </p>
        )}

        <div className="flex flex-col gap-3">
          {/* Primary CTA */}
          <a
            href={REFERRAL_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3 text-sm font-semibold text-gray-950 transition hover:bg-emerald-400"
          >
            Create Account on Hyperliquid (Free) →
          </a>

          <p className="text-xs text-gray-600">
            Already have an account? Use the button below to verify.
          </p>

          {/* Verify button — stays on gate screen while loading */}
          <button
            onClick={handleVerifyClick}
            disabled={verifying}
            className="rounded-xl border border-gray-700 px-6 py-3 text-sm font-medium text-gray-300 transition hover:border-gray-500 hover:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {verifying ? 'Verifying…' : 'I already signed up → Verify now'}
          </button>
        </div>
      </div>
    </div>
  );
}
