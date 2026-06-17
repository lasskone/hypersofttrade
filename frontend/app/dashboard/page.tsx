'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { AffiliateGate } from '@/components/AffiliateGate';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { OverviewPanel } from '@/components/dashboard/OverviewPanel';
import { TradePanel } from '@/components/dashboard/TradePanel';
import { SettingsPanel } from '@/components/dashboard/SettingsPanel';

type Section = 'overview' | 'trade' | 'bots' | 'history' | 'settings';

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const [verified, setVerified] = useState(false);
  const [section, setSection] = useState<Section>('overview');

  if (!isConnected) {
    return (
      <main
        className="flex min-h-screen items-center justify-center"
        style={{ backgroundColor: '#0a0a0f' }}
      >
        <div className="flex flex-col items-center gap-6 text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-xl font-black text-2xl"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            H
          </div>
          <div>
            <h1 className="mb-2 text-2xl font-bold text-white">HyperSoftTrade</h1>
            <p className="text-sm text-gray-400">Connect your wallet to continue</p>
          </div>
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button
                onClick={openConnectModal}
                style={{
                  background: '#00d4aa',
                  color: '#0a0a0f',
                  border: 'none',
                  padding: '12px 32px',
                  borderRadius: '8px',
                  fontSize: '16px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                Connect Wallet
              </button>
            )}
          </ConnectButton.Custom>
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
    <div className="flex min-h-screen" style={{ backgroundColor: '#0a0a0f' }}>
      <Sidebar
        active={section}
        onNavigate={setSection}
        walletAddress={address!}
      />

      <div className="flex flex-col flex-1" style={{ marginLeft: 240 }}>
        <TopBar section={section} />

        <main className="flex-1">
          {section === 'overview' && (
            <OverviewPanel walletAddress={address!} />
          )}
          {section === 'trade' && (
            <TradePanel />
          )}
          {section === 'bots' && (
            <div className="flex items-center justify-center h-64">
              <p className="text-gray-600 text-sm">Bot Library — Coming in next update</p>
            </div>
          )}
          {section === 'history' && (
            <div className="flex items-center justify-center h-64">
              <p className="text-gray-600 text-sm">Trade History — Coming in next update</p>
            </div>
          )}
          {section === 'settings' && (
            <SettingsPanel walletAddress={address!} isAffiliated={true} />
          )}
        </main>
      </div>
    </div>
  );
}
