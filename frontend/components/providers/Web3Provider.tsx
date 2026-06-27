'use client';

import { RainbowKitProvider, getDefaultConfig } from '@rainbow-me/rainbowkit';
import { WagmiProvider, http } from 'wagmi';
import { arbitrum, mainnet } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@rainbow-me/rainbowkit/styles.css';

// Use direct public RPC endpoints — avoids eth.merkle.io CORS errors from the
// default Alchemy/merkle transport that RainbowKit injects when no transports
// are specified.
const config = getDefaultConfig({
  appName: 'HyperSoftTrade',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'YOUR_PROJECT_ID',
  chains: [arbitrum, mainnet],
  transports: {
    [arbitrum.id]: http('https://arb1.arbitrum.io/rpc'),
    [mainnet.id]: http('https://ethereum.publicnode.com'),
  },
  ssr: true,
});

const queryClient = new QueryClient();

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider locale="en-US">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
