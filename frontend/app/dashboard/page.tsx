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

type FlowStep = 'connect' | 'api_setup' | 'dashboard';
type Section = 'overview' | 'trade' | 'bots' | 'history' | 'settings';

async function fetchStatus(address: string): Promise<{ is_affiliated: boolean; has_api_key: boolean }> {
  const res = await fetch(`${API_URL}/account/${address}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Dashboard layout (reused as background in api_setup) ─────────────────────
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

  // Start on 'connect' — no loading flash, no spinner, no API call on mount
  const [step, setStep] = useState<FlowStep>('connect');
  const [section, setSection] = useState<Section>('overview');
  const [affiliationError, setAffiliationError] = useState('');
  const [affiliateClicked, setAffiliateClicked] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // Single effect — runs only when wallet state changes
  useEffect(() => {
    if (!isConnected || !address) {
      // No wallet connected — show connect screen, clear any previous error
      setStep('connect');
      setAffiliationError('');
      stopPoll();
      return;
    }

    // Wallet just connected — check status
    let cancelled = false;

    (async () => {
      setAffiliationError('');
      try {
        const data = await fetchStatus(address);
        if (cancelled) return;

        if (data.is_affiliated !== true) {
          setStep('connect');
          setAffiliationError(
            'This wallet is not linked to HyperSoftTrade. Please create an account via our link first.'
          );
          // If user had already clicked the affiliate link, start polling
          if (affiliateClicked && !pollRef.current) {
            pollRef.current = setInterval(async () => {
              try {
                const d = await fetchStatus(address);
                if (d.is_affiliated === true) { stopPoll(); setStep('api_setup'); }
              } catch { /* ignore */ }
            }, 8000);
          }
          return;
        }

        if (data.has_api_key !== true) {
          stopPoll();
          setStep('api_setup');
          return;
        }

        stopPoll();
        setStep('dashboard');
      } catch {
        if (!cancelled) {
          setStep('connect');
          setAffiliationError('Could not verify affiliation. Please try again.');
        }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected]);

  const handleAffiliateClick = () => {
    setAffiliateClicked(true);
    // If wallet already connected, start polling immediately
    if (address && isConnected && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const data = await fetchStatus(address);
          if (data.is_affiliated === true) { stopPoll(); setStep('api_setup'); }
        } catch { /* ignore */ }
      }, 8000);
    }
  };

  // ── Step: connect ────────────────────────────────────────────────────────────
  if (step === 'connect') {
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
            {/* Button 1 — opens RainbowKit modal only, no affiliation logic */}
            <ConnectButton.Custom>
              {({ openConnectModal }) => (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={openConnectModal}
                    style={{
                      background: '#00d4aa',
                      color: '#0a0a0f',
                      border: 'none',
                      padding: '14px',
                      borderRadius: '8px',
                      fontSize: '16px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      width: '100%',
                    }}
                  >
                    Connect your Account
                  </button>
                  <p className="text-xs text-center" style={{ color: '#6b7280' }}>
                    Use your affiliated Hyperliquid wallet
                  </p>
                </div>
              )}
            </ConnectButton.Custom>

            {/* Affiliation error — only shown after wallet connects and check returns false */}
            {affiliationError && (
              <div
                className="rounded-lg px-4 py-2.5 text-xs leading-relaxed"
                style={{ backgroundColor: '#ef44440f', color: '#f87171' }}
              >
                {affiliationError}
              </div>
            )}

            {/* Divider */}
            <div className="flex items-center gap-3 my-1">
              <div className="flex-1 h-px" style={{ backgroundColor: '#1a1a2e' }} />
              <span className="text-xs" style={{ color: '#6b7280' }}>— or —</span>
              <div className="flex-1 h-px" style={{ backgroundColor: '#1a1a2e' }} />
            </div>

            {/* Button 2 — opens affiliate link in new tab */}
            <div className="flex flex-col gap-1.5">
              <a
                href={REFERRAL_LINK}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleAffiliateClick}
                className="w-full py-3 rounded-xl text-sm font-semibold text-center transition-opacity hover:opacity-80"
                style={{ border: '1px solid #00d4aa', color: '#00d4aa', display: 'block' }}
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

  // ── Step: api_setup ──────────────────────────────────────────────────────────
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

  // ── Step: dashboard ──────────────────────────────────────────────────────────
  return (
    <DashboardLayout address={address!} section={section} onNavigate={setSection} />
  );
}
