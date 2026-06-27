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
        "https://*.walletconnect.com",
        "wss://*.walletconnect.com",
        "https://*.walletconnect.org",
        "wss://*.walletconnect.org",
        "https://hypersofttrade.com",
        "https://www.hypersofttrade.com",
        "https://api.hypersofttrade.com",
      ].join(' '),
      "frame-src 'self' https://*.walletconnect.com https://*.walletconnect.org",
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
