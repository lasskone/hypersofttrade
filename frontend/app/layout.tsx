import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Web3Provider } from '@/components/providers/Web3Provider';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const geistSans = localFont({
  src: './fonts/GeistVF.woff',
  variable: '--font-geist-sans',
  weight: '100 900',
});
const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
  weight: '100 900',
});

export const metadata: Metadata = {
  title: 'HyperSoftTrade — Advanced Crypto Terminal',
  description: 'Professional crypto trading terminal powered by Hyperliquid DEX.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-gray-950 text-gray-100`}>
        <ErrorBoundary>
          <Web3Provider>
            {children}
          </Web3Provider>
        </ErrorBoundary>
      </body>
    </html>
  );
}
