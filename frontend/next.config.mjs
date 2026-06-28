/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    // Block eth.merkle.io (and similar RainbowKit/Alchemy default RPC hosts)
    // at the browser level while allowing all services HyperSoftTrade actually uses.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      [
        "connect-src 'self'",
        "https://*.hyperliquid.xyz",
        "wss://*.hyperliquid.xyz",
        "https://*.railway.app",
        "https://*.supabase.co",
        "wss://*.supabase.co",
        "https://arb1.arbitrum.io",
        "https://ethereum.publicnode.com",
        // WalletConnect — wildcard + explicit subdomains that some browsers
        // refuse to match via *.walletconnect.com alone
        "https://*.walletconnect.com",
        "https://pulse.walletconnect.com",
        "https://relay.walletconnect.com",
        "https://explorer-api.walletconnect.com",
        "wss://*.walletconnect.com",
        "https://*.walletconnect.org",
        "wss://*.walletconnect.org",
        // Web3Modal / AppKit (WalletConnect's modal layer)
        "https://api.web3modal.org",
        "https://*.web3modal.org",
        "https://api.web3modal.com",
        "https://*.web3modal.com",
        "https://appkit.walletconnect.com",
        "https://*.appkit.walletconnect.com",
        // Coinbase Wallet
        "https://*.coinbase.com",
        "wss://*.coinbase.com",
        "https://hypersofttrade.com",
        "https://www.hypersofttrade.com",
        "https://api.hypersofttrade.com",
      ].join(' '),
      "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org https://*.coinbase.com https://*.web3modal.org https://*.web3modal.com",
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [{ key: 'Content-Security-Policy', value: csp }],
      },
    ];
  },
};

export default nextConfig;
