'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { AffiliateGate } from '@/components/AffiliateGate';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { OverviewPanel } from '@/components/dashboard/OverviewPanel';
import { TradePanel } from '@/components/dashboard/TradePanel';
import { SettingsPanel } from '@/components/dashboard/SettingsPanel';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';

type FlowStep = 'loading' | 'connect_wallet' | 'affiliation' | 'onboarding' | 'dashboard';
type Section = 'overview' | 'trade' | 'bots' | 'history' | 'settings';

// ─── Loading screen ───────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
      <div className="flex flex-col items-center gap-4">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-xl"
          style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
        >
          H
        </div>
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-gray-800"
          style={{ borderTopColor: '#00d4aa' }}
        />
        <p className="text-sm text-gray-600">Loading...</p>
      </div>
    </main>
  );
}

// ─── Connect wallet screen ────────────────────────────────────────────────────
function ConnectWalletScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
      <div
        className="mx-4 w-full max-w-[400px] rounded-2xl border p-8 text-center"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        <div
          className="w-12 h-12 rounded-xl mx-auto mb-5 flex items-center justify-center font-black text-xl"
          style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
        >
          H
        </div>
        <h1 className="text-2xl font-bold text-white mb-2">HyperSoftTrade</h1>
        <p className="text-sm text-gray-400 mb-8">Professional crypto trading terminal</p>

        <ConnectButton.Custom>
          {({ openConnectModal }) => (
            <button
              onClick={openConnectModal}
              className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80"
              style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
            >
              Connect Wallet
            </button>
          )}
        </ConnectButton.Custom>

        <p className="mt-6 text-xs text-gray-600">Free platform · Powered by Hyperliquid DEX</p>
      </div>
    </main>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [step, setStep] = useState<FlowStep>('loading');
  const [section, setSection] = useState<Section>('overview');

  useEffect(() => {
    if (!isConnected || !address) {
      setStep('connect_wallet');
      return;
    }

    (async () => {
      setStep('loading');
      try {
        const res = await fetch(`${API_URL}/account/${address}/status`);
        if (!res.ok) {
          setStep('affiliation');
          return;
        }
        const data = await res.json();
        // Affiliation must be explicitly true — anything else falls back to the gate
        if (data.is_affiliated !== true) {
          setStep('affiliation');
          return;
        }
        // Affiliated: check API key
        if (data.has_api_key !== true) {
          setStep('onboarding');
          return;
        }
        setStep('dashboard');
      } catch {
        // Network error → safest fallback is always the affiliation gate
        setStep('affiliation');
      }
    })();
  }, [address, isConnected]);

  if (step === 'loading') return <LoadingScreen />;
  if (step === 'connect_wallet') return <ConnectWalletScreen />;

  if (step === 'affiliation') {
    return (
      <AffiliateGate
        walletAddress={address!}
        onVerified={() => setStep('onboarding')}
      />
    );
  }

  if (step === 'onboarding') {
    return (
      <OnboardingFlow
        walletAddress={address!}
        onComplete={() => setStep('dashboard')}
      />
    );
  }

  // step === 'dashboard'
  return (
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0f' }}>
      <Sidebar active={section} onNavigate={setSection} walletAddress={address!} />

      <div className="flex flex-col flex-1" style={{ marginLeft: 240 }}>
        <TopBar section={section} />

        <main className="flex-1">
          {section === 'overview' && <OverviewPanel walletAddress={address!} />}
          {section === 'trade' && <TradePanel />}
          {section === 'bots' && (
            <div className="flex items-center justify-center h-64">
              <p className="text-sm text-gray-600">Bot Library — Coming in next update</p>
            </div>
          )}
          {section === 'history' && (
            <div className="flex items-center justify-center h-64">
              <p className="text-sm text-gray-600">Trade History — Coming in next update</p>
            </div>
          )}
          {section === 'settings' && <SettingsPanel walletAddress={address!} />}
        </main>
      </div>
    </div>
  );
}
