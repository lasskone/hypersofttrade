'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiKeyModal } from '@/components/onboarding/ApiKeyModal';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { OverviewPanel } from '@/components/dashboard/OverviewPanel';
import { TradePanel } from '@/components/dashboard/TradePanel';
import { SettingsPanel } from '@/components/dashboard/SettingsPanel';
import BotsPanel from '@/components/dashboard/BotsPanel';
import BacktestPanel from '@/components/dashboard/BacktestPanel';
import BotDetailPanel from '@/components/dashboard/BotDetailPanel';
import HistoryPanel from '@/components/dashboard/HistoryPanel';
import ScannerPanel from '@/components/dashboard/ScannerPanel';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hypersofttrade-backend-production.up.railway.app';
const REFERRAL_LINK = 'https://app.hyperliquid.xyz/join/KNS';
const HST_WALLET_KEY = 'hst_wallet_address';

type FlowStep = 'loading' | 'checking' | 'connect' | 'api_setup' | 'dashboard';

const PORTFOLIO_POLL_INITIAL_MS = 10_000
const PORTFOLIO_POLL_MAX_MS     = 40_000

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
  const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''
  const [openPositions, setOpenPositions] = useState<any[]>([])
  const [openOrders, setOpenOrders] = useState<any[]>([])
  const [spotBalances, setSpotBalances] = useState<any[]>([])
  const [recentTrades, setRecentTrades] = useState<any[]>([])
  const [pendingMarket, setPendingMarket] = useState<{ symbol: string, dex: string, interval?: string } | null>(null)
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  const [isPortfolioStale, setIsPortfolioStale] = useState(false)
  const portfolioPollDelayRef = useRef<number>(PORTFOLIO_POLL_INITIAL_MS)
  const portfolioPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Kept as a stable callback so it can be passed as onRefresh to TradePanel.
  // On success it also clears stale state and resets backoff delay.
  const fetchPositions = useCallback(async () => {
    if (!address) return
    try {
      const res = await fetch(`${API_URL}/account/${address}/portfolio`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        console.warn('[fetchPositions] unexpected response shape:', data)
        return
      }
      setOpenPositions(Array.isArray(data.open_positions) ? data.open_positions : [])
      setOpenOrders(Array.isArray(data.open_orders) ? data.open_orders : [])
      setSpotBalances(Array.isArray(data.spot_balances) ? data.spot_balances : [])
      setRecentTrades(Array.isArray(data.recent_fills) ? data.recent_fills : [])
      setIsPortfolioStale(false)
      portfolioPollDelayRef.current = PORTFOLIO_POLL_INITIAL_MS
    } catch {}
  }, [address])

  // Initial load.
  useEffect(() => {
    if (!address) return
    fetchPositions()
  }, [address, fetchPositions])

  // Background poll with exponential backoff.
  // Failure: preserve last good state, show stale indicator, back off.
  // First success after failure: reset delay to base immediately.
  useEffect(() => {
    if (!address) return
    portfolioPollDelayRef.current = PORTFOLIO_POLL_INITIAL_MS
    let cancelled = false

    const pollOnce = async () => {
      try {
        const res = await fetch(`${API_URL}/account/${address}/portfolio`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        if (!data || typeof data !== 'object' || Array.isArray(data)) return
        setOpenPositions(Array.isArray(data.open_positions) ? data.open_positions : [])
        setOpenOrders(Array.isArray(data.open_orders) ? data.open_orders : [])
        setSpotBalances(Array.isArray(data.spot_balances) ? data.spot_balances : [])
        setRecentTrades(Array.isArray(data.recent_fills) ? data.recent_fills : [])
        setIsPortfolioStale(false)
        portfolioPollDelayRef.current = PORTFOLIO_POLL_INITIAL_MS
      } catch {
        if (cancelled) return
        setIsPortfolioStale(true)
        portfolioPollDelayRef.current = Math.min(portfolioPollDelayRef.current * 2, PORTFOLIO_POLL_MAX_MS)
      }
    }

    const schedule = () => {
      portfolioPollTimerRef.current = setTimeout(async () => {
        if (cancelled) return
        await pollOnce()
        if (!cancelled) schedule()
      }, portfolioPollDelayRef.current)
    }

    schedule()

    return () => {
      cancelled = true
      if (portfolioPollTimerRef.current !== null) clearTimeout(portfolioPollTimerRef.current)
    }
  }, [address])

  return (
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0f' }}>
      <Sidebar active={section} onNavigate={onNavigate} walletAddress={address} />
      <div className="flex flex-col flex-1" style={{ marginLeft: 240 }}>
        <TopBar section={section} />
        {isPortfolioStale && (
          <div style={{ padding: '4px 16px', background: 'rgba(245,158,11,0.08)', borderBottom: '1px solid rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 500 }}>↻ Portfolio data reconnecting…</span>
          </div>
        )}
        <main className="flex-1">
          {section === 'overview' && <OverviewPanel walletAddress={address} onNavigate={onNavigate} onSelectMarket={(symbol, dex, interval) => setPendingMarket({ symbol, dex, interval })} />}
          {section === 'trade' && <TradePanel walletAddress={address} openPositions={openPositions} openOrders={openOrders} spotBalances={spotBalances} recentTrades={recentTrades} initialMarket={pendingMarket} initialInterval={pendingMarket?.interval ?? '15m'} onMarketConsumed={() => setPendingMarket(null)} onRefresh={fetchPositions} />}
          {section === 'bots' && <BotsPanel walletAddress={address ?? ''} onSelectBot={(id) => { setSelectedBotId(id); onNavigate('bot_detail') }} />}
          {section === 'bot_detail' && selectedBotId && <BotDetailPanel botId={selectedBotId} walletAddress={address} onBack={() => onNavigate('bots')} />}
          {section === 'backtest' && <BacktestPanel walletAddress={address} />}
          {section === 'history' && <HistoryPanel walletAddress={address} />}
          {section === 'scanner' && <ScannerPanel walletAddress={address} />}
          {section === 'settings' && <SettingsPanel walletAddress={address} />}
        </main>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [walletAddress, setWalletAddress] = useState('');
  const [walletInput, setWalletInput] = useState('');
  const [step, setStep] = useState<FlowStep>('loading');
  const [section, setSection] = useState<string>('overview');
  const [affiliationError, setAffiliationError] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [affiliateClicked, setAffiliateClicked] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Verify affiliation for a given address, then route to the appropriate step.
  // On success (affiliated): writes address to localStorage and updates state.
  // On failure (not affiliated): shows error, does NOT write to localStorage.
  const checkStatus = useCallback(async (addr: string) => {
    setIsChecking(true);
    setAffiliationError('');
    setStep('checking');
    try {
      // Always call verify-affiliation first so the DB is refreshed from
      // Hyperliquid on every connect — this ensures users who signed up
      // after our link was shared (or are in the master referral list)
      // are recognised without needing a separate manual verification step.
      const verifyRes = await fetch(`${API_URL}/account/verify-affiliation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: addr }),
      });

      // Non-2xx means the backend couldn't complete the Hyperliquid check
      // (503 = retries exhausted; DB was NOT updated). Do not proceed to /status
      // — the DB value is stale/unknown. Show a transient-failure message so the
      // user retries rather than seeing a false "wallet not linked" rejection.
      if (!verifyRes.ok) {
        setWalletInput(addr);
        setAffiliationError('Connection issue — please try again.');
        setStep('connect');
        return;
      }

      const res = await fetch(`${API_URL}/account/${addr}/status`);
      const data = await res.json();

      if (!data.is_affiliated) {
        setAffiliationError(
          'This wallet is not linked to HyperSoftTrade. ' +
          'Please create an account via our link first.'
        );
        setStep('connect');
      } else {
        // Affiliated — persist address and unlock the app.
        localStorage.setItem(HST_WALLET_KEY, addr);
        setWalletAddress(addr);
        if (!data.has_api_key) {
          setStep('api_setup');
        } else {
          setStep('dashboard');
        }
      }
    } catch {
      // Network/fetch error — pre-fill the input with the attempted address so
      // the user can retry without retyping, and show a transient-failure message
      // distinct from the "not affiliated" rejection message.
      setWalletInput(addr);
      setAffiliationError('Connection issue — please try again.');
      setStep('connect');
    } finally {
      setIsChecking(false);
    }
  }, []);

  // On mount: read stored address from localStorage. If present, re-verify and
  // route directly into the app. If absent, show the entry screen.
  useEffect(() => {
    if (!mounted) return;
    const stored = localStorage.getItem(HST_WALLET_KEY);
    if (!stored) {
      setStep('connect');
      return;
    }
    checkStatus(stored);
  }, [mounted, checkStatus]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = walletInput.trim();
    if (!addr) return;
    await checkStatus(addr);
  };

  const handleAffiliateClick = () => {
    setAffiliateClicked(true);
  };

  // Branded loading screen — shown during initial mount and while the
  // affiliation/API-key check is in flight.
  if (step === 'loading' || step === 'checking') {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4"
        style={{ backgroundColor: '#0a0a0f' }}
      >
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center font-black text-2xl mb-2"
          style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
        >
          H
        </div>
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: '#26a69a' }}>
          HyperSoftTrade
        </h1>
        <p className="text-sm" style={{ color: '#6b7280' }}>
          Initializing terminal…
        </p>
        <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mt-2" />
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
            {/* Wallet address entry form */}
            <form onSubmit={handleConnect} style={{ width: '100%' }}>
              <input
                type="text"
                placeholder="0x… your affiliated Hyperliquid wallet"
                value={walletInput}
                onChange={e => setWalletInput(e.target.value)}
                className="w-full rounded-lg px-3 py-2.5 text-sm text-white outline-none font-mono mb-3"
                style={{ backgroundColor: '#0a0a0f', border: '1px solid #1a1a2e' }}
                onFocus={e => (e.currentTarget.style.borderColor = '#00d4aa')}
                onBlur={e => (e.currentTarget.style.borderColor = '#1a1a2e')}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="submit"
                disabled={isChecking || !walletInput.trim()}
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
                  opacity: isChecking || !walletInput.trim() ? 0.5 : 1,
                }}
              >
                {isChecking ? 'Verifying…' : 'Connect your Account'}
              </button>
              <p style={{
                color: '#6b7280',
                fontSize: '12px',
                textAlign: 'center',
                marginTop: '8px',
              }}>
                Use your affiliated Hyperliquid wallet
              </p>
              {affiliationError && (
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
            </form>

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
                  ? "Waiting for your account… Enter your wallet above when done"
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
    if (!walletAddress) return null;
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
          <DashboardLayout address={walletAddress} section={section} onNavigate={setSection} />
        </div>

        {/* API key modal on top */}
        <ApiKeyModal
          walletAddress={walletAddress}
          onComplete={() => setStep('dashboard')}
        />
      </>
    );
  }

  // ── Step: dashboard ──────────────────────────────────────────────────────────
  if (!walletAddress) return null;
  return (
    <DashboardLayout address={walletAddress} section={section} onNavigate={setSection} />
  );
}
