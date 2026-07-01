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
      const errMsg = this.state.error?.message ?? '';
      const isWalletError = /ethereum|metamask|wallet|injected|web3|provider|connector/i.test(errMsg);

      const logo = (
        <div
          style={{
            width: 48, height: 48, borderRadius: 12, background: '#00d4aa', color: '#0a0a0f',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 900, fontSize: 22, marginBottom: 8,
          }}
        >
          H
        </div>
      );

      const retryButton = (
        <button
          onClick={() => this.setState({ hasError: false, error: null })}
          style={{
            marginTop: 16, padding: '8px 24px', background: '#26a69a', color: '#fff',
            border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600,
          }}
        >
          Retry
        </button>
      );

      if (isWalletError) {
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#0a0a0f', color: '#fff', gap: '8px' }}>
            {logo}
            <h2 style={{ color: '#26a69a', margin: 0 }}>Wallet Required</h2>
            <p style={{ color: 'rgba(255,255,255,0.5)', margin: 0, fontSize: 14, textAlign: 'center', maxWidth: 340 }}>
              To use HyperSoftTrade, you need a Web3 wallet. Please install MetaMask or any compatible wallet and refresh the page.
            </p>
            <a
              href="https://metamask.io/download/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginTop: 8, color: '#26a69a', fontSize: 14, fontWeight: 600 }}
            >
              Install MetaMask →
            </a>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              style={{ marginTop: 16, padding: '8px 24px', background: '#26a69a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}
            >
              Refresh
            </button>
          </div>
        );
      }

      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#0a0a0f', color: '#fff', gap: '8px' }}>
          {logo}
          <h2 style={{ color: '#ef4444', margin: 0 }}>Something went wrong</h2>
          <p style={{ color: 'rgba(255,255,255,0.5)', margin: 0, fontSize: 14, textAlign: 'center', maxWidth: 400 }}>
            An unexpected error occurred. The details have been logged to the console.
          </p>
          {errMsg && (
            <p style={{ color: '#6b7280', margin: 0, fontSize: 12, textAlign: 'center', maxWidth: 480, fontFamily: 'monospace', background: '#13131f', padding: '8px 14px', borderRadius: 6, border: '1px solid #1a1a2e' }}>
              {errMsg}
            </p>
          )}
          {retryButton}
        </div>
      );
    }

    return this.props.children;
  }
}
