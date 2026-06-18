'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ApiKeyModal } from '@/components/onboarding/ApiKeyModal';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { OverviewPanel } from '@/components/dashboard/OverviewPanel';
import { TradePanel } from '@/components/dashboard/TradePanel';
import { SettingsPanel } from '@/components/dashboard/SettingsPanel';
import BotsPanel from '@/components/dashboard/BotsPanel';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';
const REFERRAL_LINK = 'https://app.hyperliquid.xyz/join/KNS';

type FlowStep = 'connect' | 'api_setup' | 'dashboard';

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
  section: string;
  onNavigate: (s: string) => void;
}) {
  return (
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0f' }}>
      <Sidebar active={section} onNavigate={onNavigate} walletAddress={address} />
      <div className="flex flex-col flex-1" style={{ marginLeft: 240 }}>
        <TopBar section={section} />
        <main className="flex-1">
          {section === 'overview' && <OverviewPanel walletAddress={address} onNavigate={onNavigate} />}
          {section === 'trade' && <TradePanel walletAddress={address} />}
          {section === 'bots' && <BotsPanel walletAddress={address ?? ''} />}
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
  const { address, isConnected, status } = useAccount();

  const [step, setStep] = useState<FlowStep>('connect');
  const [section, setSection] = useState<string>('overview');
  const [affiliationError, setAffiliationError] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [affiliateClicked, setAffiliateClicked] = useState(false);
  const [connectAttempted, setConnectAttempted] = useState(false);
  const [showConnectHint, setShowConnectHint] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    // Clear error every time this runs
    setAffiliationError('');

    // No wallet — stay on connect screen, do nothing else
    if (!isConnected || !address) {
      if (mounted) setStep('connect');
      return;
    }

    // Wallet connected — now check status
    // Small delay to let RainbowKit modal close gracefully
    const timer = setTimeout(() => {
      const checkStatus = async () => {
        setIsChecking(true);
        try {
          const res = await fetch(`${API_URL}/account/${address}/status`);
          const data = await res.json();
          if (!data.is_affiliated) {
            setAffiliationError(
              'This wallet is not linked to HyperSoftTrade. ' +
              'Please create an account via our link first.'
            );
            setStep('connect');
          } else if (!data.has_api_key) {
            setStep('api_setup');
          } else {
            setStep('dashboard');
          }
        } catch {
          // Network error — stay on connect, no error shown
          setStep('connect');
        } finally {
          setIsChecking(false);
        }
      };
      checkStatus();
    }, 1000);
    return () => clearTimeout(timer);
  }, [address, isConnected]);

  // Show hint 2 seconds after a connect attempt if still on connect screen
  useEffect(() => {
    if (!connectAttempted) return;
    const t = setTimeout(() => setShowConnectHint(true), 2000);
    return () => clearTimeout(t);
  }, [connectAttempted]);

  const handleAffiliateClick = () => {
    setAffiliateClicked(true);
  };

  if (!mounted || status === 'reconnecting' || status === 'connecting') {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ backgroundColor: '#0a0a0f' }}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm" style={{ color: '#6b7280' }}>Loading terminal...</p>
        </div>
      </div>
    );
  }

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
            <ConnectButton.Custom>
              {({ openConnectModal }) => (
                <div style={{ width: '100%' }}>
                  <button
                    onClick={() => { setConnectAttempted(true); openConnectModal(); }}
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
                  <p style={{
                    color: '#6b7280',
                    fontSize: '12px',
                    textAlign: 'center',
                    marginTop: '8px',
                  }}>
                    Use your affiliated Hyperliquid wallet
                  </p>
                  {showConnectHint && (
                    <p style={{ color: '#f59e0b', fontSize: '11px', textAlign: 'center', marginTop: '4px' }}>
                      Having trouble? Try disabling browser extensions or use incognito mode.
                    </p>
                  )}
                  {isConnected && affiliationError && (
                    <div style={{
                      background: 'rgba(239,68,68,0.1)',
                      border: '1px solid rgba(239,68,68,0.3)',
                      borderRadius: '6px',
                      padding: '10px',
                      marginTop: '8px',
                      color: '#ef4444',
                      fontSize: '13px',
                      textAlign: 'center',
                    }}>
                      {affiliationError}
                    </div>
                  )}
                </div>
              )}
            </ConnectButton.Custom>

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
