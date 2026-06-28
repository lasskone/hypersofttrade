'use client';

import React from 'react';

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('App error caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      const msg = (this.state.error?.message ?? '').toLowerCase();
      const isNoWallet = /wallet|injected|provider|ethereum/.test(msg);

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            background: '#0a0a0f',
            color: '#fff',
            gap: '8px',
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: '#00d4aa',
              color: '#0a0a0f',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 900,
              fontSize: 22,
              marginBottom: 8,
            }}
          >
            H
          </div>
          {isNoWallet ? (
            <>
              <h2 style={{ color: '#26a69a', margin: 0 }}>No wallet detected</h2>
              <p style={{ color: 'rgba(255,255,255,0.5)', margin: 0, fontSize: 14, textAlign: 'center', maxWidth: 340 }}>
                No wallet detected. Please install MetaMask or another Web3 wallet to use HyperSoftTrade.
              </p>
              <a
                href="https://metamask.io/download/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginTop: 8, color: '#00d4aa', fontSize: 14, fontWeight: 600 }}
              >
                Install MetaMask →
              </a>
            </>
          ) : (
            <>
              <h2 style={{ color: '#26a69a', margin: 0 }}>Something went wrong</h2>
              <p style={{ color: 'rgba(255,255,255,0.5)', margin: 0, fontSize: 14 }}>
                Please refresh the page and try again.
              </p>
            </>
          )}
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            style={{
              marginTop: 16,
              padding: '8px 24px',
              background: '#26a69a',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Refresh
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
