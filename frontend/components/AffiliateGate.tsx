'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';
const REFERRAL_LINK = 'https://app.hyperliquid.xyz/join/KNS';

interface Props {
  walletAddress: string;
  onVerified: () => void;
}

type CheckState = 'idle' | 'checking' | 'affiliated' | 'not_affiliated' | 'error';

export function AffiliateGate({ walletAddress, onVerified }: Props) {
  const [state, setState] = useState<CheckState>('idle');

  const checkAffiliation = async () => {
    setState('checking');
    try {
      const res = await fetch(`${API_URL}/account/verify-affiliation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: walletAddress }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.is_affiliated) {
        setState('affiliated');
        onVerified();
      } else {
        setState('not_affiliated');
      }
    } catch (err) {
      console.error('[AffiliateGate] verify-affiliation failed:', err);
      setState('error');
    }
  };

  useEffect(() => {
    if (walletAddress) checkAffiliation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  if (state === 'checking' || state === 'idle') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-4 text-gray-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-emerald-500" />
          <p className="text-sm">Verifying affiliation…</p>
        </div>
      </div>
    );
  }

  if (state === 'affiliated') {
    return null;
  }

  // not_affiliated or error
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/95 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center shadow-2xl">
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

        {state === 'error' && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-4 py-2 text-xs text-red-400">
            Could not reach the verification server. Please try again.
          </p>
        )}

        <div className="flex flex-col gap-3">
          <a
            href={REFERRAL_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3 text-sm font-semibold text-gray-950 transition hover:bg-emerald-400"
          >
            Get Started on Hyperliquid →
          </a>

          <button
            onClick={checkAffiliation}
            className="rounded-xl border border-gray-700 px-6 py-3 text-sm font-medium text-gray-300 transition hover:border-gray-500 hover:text-gray-100"
          >
            I already signed up → Verify now
          </button>
        </div>
      </div>
    </div>
  );
}
