'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ApiKeyModal } from '@/components/onboarding/ApiKeyModal';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { OverviewPanel } from '@/components/dashboard/OverviewPanel';
import { TradePanel } from '@/components/dashboard/TradePanel';
import { SettingsPanel } from '@/components/dashboard/SettingsPanel';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';
const REFERRAL_LINK = 'https://app.hyperliquid.xyz/join/KNS';

type FlowStep = 'loading' | 'connect' | 'api_setup' | 'dashboard';
type Section = 'overview' | 'trade' | 'bots' | 'history' | 'settings';

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function fetchStatus(address: string): Promise<{ is_affiliated: boolean; has_api_key: boolean }> {
  const res = await fetch(`${API_URL}/account/${address}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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
        <p className="text-sm text-gray-600">Loading…</p>
      </div>
    </main>
  );
}

// ─── Step 1: Connection page ──────────────────────────────────────────────────
function ConnectPage({ onAffiliated }: { onAffiliated: () => void }) {
  const { address, isConnected } = useAccount();
  const [affiliateClicked, setAffiliateClicked] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // When wallet connects (or is already connected), silently check affiliation
  useEffect(() => {
    if (!isConnected || !address) {
      setConnectError(null);
      stopPoll();
      return;
    }
    (async () => {
      setChecking(true);
      setConnectError(null);
      try {
        const data = await fetchStatus(address);
        if (data.is_affiliated === true) {
          stopPoll();
          onAffiliated();
        } else {
          setConnectError(
            'This wallet is not linked to HyperSoftTrade. Please create an account via our link first.'
          );
        }
      } catch {
        setConnectError('Could not verify affiliation. Please try again.');
      } finally {
        setChecking(false);
      }
    })();
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected]);

  // After "Create your Account" clicked + wallet connected: auto-poll
  const handleAffiliateClick = () => {
    setAffiliateClicked(true);
    if (!address || !isConnected) return; // no wallet yet — poll starts when wallet connects via effect
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await fetchStatus(address);
        if (data.is_affiliated === true) {
          stopPoll();
          onAffiliated();
        }
      } catch {
        // ignore silently
      }
    }, 8000);
  };

  // Also start polling when wallet becomes available after affiliate click
  useEffect(() => {
    if (!affiliateClicked || !isConnected || !address || pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await fetchStatus(address);
        if (data.is_affiliated === true) {
          stopPoll();
          onAffiliated();
        }
      } catch {
        // ignore silently
      }
    }, 8000);
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [affiliateClicked, isConnected, address]);

  return (
    <main className="flex min-h-screen items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
      <div
        className="mx-4 w-full max-w-[420px] rounded-2xl border p-8 shadow-2xl"
        style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
      >
        {/* Logo + header */}
        <div className="flex flex-col items-center mb-8">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center font-black text-xl mb-4"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            H
          </div>
          <h1 className="text-2xl font-bold text-white">HyperSoftTrade</h1>
          <p className="text-xs mt-1.5" style={{ color: '#6b7280' }}>
            Professional crypto trading terminal · Free forever
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {/* Button 1 — Connect existing account */}
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={openConnectModal}
                  disabled={checking}
                  className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80 disabled:opacity-60 disabled:cursor-wait"
                  style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
                >
                  {checking ? 'Checking affiliation…' : 'Connect your Account'}
                </button>
                <p className="text-xs text-center" style={{ color: '#6b7280' }}>
                  Use your affiliated Hyperliquid wallet
                </p>
              </div>
            )}
          </ConnectButton.Custom>

          {/* Affiliation error */}
          {connectError && (
            <div
              className="rounded-lg px-4 py-2.5 text-xs leading-relaxed"
              style={{ backgroundColor: '#ef44440f', color: '#f87171' }}
            >
              {connectError}
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3 my-1">
            <div className="flex-1 h-px" style={{ backgroundColor: '#1a1a2e' }} />
            <span className="text-xs" style={{ color: '#6b7280' }}>— or —</span>
            <div className="flex-1 h-px" style={{ backgroundColor: '#1a1a2e' }} />
          </div>

          {/* Button 2 — Create new account */}
          <div className="flex flex-col gap-1.5">
            <a
              href={REFERRAL_LINK}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleAffiliateClick}
              className="w-full py-3 rounded-xl text-sm font-semibold text-center transition-opacity hover:opacity-80"
              style={{ border: '1px solid #00d4aa', color: '#00d4aa' }}
            >
              {affiliateClicked
                ? "Waiting for your account… Click 'Connect' when done"
                : 'Create your Account'}
            </a>
            <p className="text-xs text-center" style={{ color: '#6b7280' }}>
              Use our affiliate link · It&apos;s free
            </p>
          </div>
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-xs leading-relaxed" style={{ color: '#4b5563' }}>
          By connecting, you agree to trade on Hyperliquid DEX through HyperSoftTrade.
        </p>
      </div>
    </main>
  );
}

// ─── Dashboard layout (shared between api_setup and dashboard) ────────────────
function DashboardLayout({
  address,
  section,
  onNavigate,
}: {
  address: string;
  section: Section;
  onNavigate: (s: Section) => void;
}) {
  return (
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0f' }}>
      <Sidebar active={section} onNavigate={onNavigate} walletAddress={address} />
      <div className="flex flex-col flex-1" style={{ marginLeft: 240 }}>
        <TopBar section={section} />
        <main className="flex-1">
          {section === 'overview' && <OverviewPanel walletAddress={address} />}
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
          {section === 'settings' && <SettingsPanel walletAddress={address} />}
        </main>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [step, setStep] = useState<FlowStep>('loading');
  const [section, setSection] = useState<Section>('overview');

  useEffect(() => {
    if (!isConnected || !address) {
      setStep('connect');
      return;
    }
    (async () => {
      setStep('loading');
      try {
        const data = await fetchStatus(address);
        if (data.is_affiliated !== true) {
          setStep('connect');
          return;
        }
        if (data.has_api_key !== true) {
          setStep('api_setup');
          return;
        }
        setStep('dashboard');
      } catch {
        setStep('connect');
      }
    })();
  }, [address, isConnected]);

  if (step === 'loading') return <LoadingScreen />;

  if (step === 'connect') {
    return <ConnectPage onAffiliated={() => setStep('api_setup')} />;
  }

  if (step === 'api_setup') {
    return (
      <>
        {/* Blurred dashboard in background */}
        <div
          style={{
            filter: 'blur(6px)',
            pointerEvents: 'none',
            userSelect: 'none',
            position: 'fixed',
            inset: 0,
            overflow: 'hidden',
          }}
        >
          <DashboardLayout address={address!} section={section} onNavigate={setSection} />
        </div>

        {/* API key modal on top */}
        <ApiKeyModal
          walletAddress={address!}
          onComplete={() => setStep('dashboard')}
        />
      </>
    );
  }

  // step === 'dashboard'
  return (
    <DashboardLayout address={address!} section={section} onNavigate={setSection} />
  );
}
