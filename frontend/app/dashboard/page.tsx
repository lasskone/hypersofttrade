'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { AffiliateGate } from '@/components/AffiliateGate';

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [verified, setVerified] = useState(false);

  if (!isConnected) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-500">
            <span className="text-2xl font-black text-gray-950">H</span>
          </div>
          <div>
            <h1 className="mb-2 text-2xl font-bold text-gray-100">HyperSoftTrade</h1>
            <p className="text-sm text-gray-400">Connect your wallet to continue</p>
          </div>
          <ConnectButton />
        </div>
      </main>
    );
  }

  if (!verified) {
    return (
      <AffiliateGate
        walletAddress={address!}
        onVerified={() => setVerified(true)}
      />
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded bg-emerald-500 flex items-center justify-center">
            <span className="text-gray-950 font-black">H</span>
          </div>
          <h1 className="text-2xl font-bold">HyperSoftTrade Dashboard</h1>
          <span className="ml-auto font-mono text-xs text-gray-500">
            {address}
          </span>
        </div>

        <p className="mb-8 text-gray-400">
          Welcome to HyperSoftTrade Dashboard
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {['Portfolio', 'Open Positions', 'Active Bots'].map((panel) => (
            <div
              key={panel}
              className="rounded-xl border border-gray-800 bg-gray-900 p-6 flex flex-col gap-2"
            >
              <h2 className="text-sm font-medium text-gray-400">{panel}</h2>
              <p className="text-2xl font-bold text-gray-200">—</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
