import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: '#0a0a0f', color: '#e5e7eb' }}>
      {/* NAVBAR */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            H
          </div>
          <span className="font-bold text-base tracking-tight text-white">HyperSoftTrade</span>
        </div>
        <Link
          href="/dashboard"
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-opacity hover:opacity-80"
          style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
        >
          Launch App
        </Link>
      </nav>

      {/* HERO */}
      <section className="flex flex-col items-center justify-center text-center px-6 pt-24 pb-20">
        {/* Badge */}
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-medium mb-8 border"
          style={{ borderColor: '#00d4aa33', backgroundColor: '#00d4aa0d', color: '#00d4aa' }}
        >
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: '#00d4aa' }} />
          Free Platform · Powered by Hyperliquid DEX
        </div>

        <h1 className="text-5xl md:text-6xl font-black tracking-tight text-white leading-tight mb-6">
          Trade Smarter.<br />Earn More.
        </h1>

        <p className="text-lg text-gray-400 max-w-xl mb-10 leading-relaxed">
          Professional crypto trading terminal with automated bots.
          100% free — we earn when you trade.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 mb-16">
          <Link
            href="/dashboard"
            className="px-7 py-3 rounded-xl font-semibold text-sm transition-opacity hover:opacity-80"
            style={{ backgroundColor: '#00d4aa', color: '#0a0a0f' }}
          >
            Start Trading →
          </Link>
          <Link
            href="/dashboard"
            className="px-7 py-3 rounded-xl font-semibold text-sm border transition-colors hover:border-white/30"
            style={{ borderColor: '#00d4aa55', color: '#00d4aa', backgroundColor: 'transparent' }}
          >
            View Bot Library
          </Link>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap justify-center gap-8 text-center">
          {[
            ['60+', 'Assets'],
            ['3', 'Bot Strategies'],
            ['0$', 'Fees'],
            ['24/7', 'Automated'],
          ].map(([value, label]) => (
            <div key={label} className="flex flex-col gap-1">
              <span className="text-2xl font-black" style={{ color: '#00d4aa' }}>{value}</span>
              <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section className="px-6 pb-20 max-w-5xl mx-auto w-full">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              title: 'Manual Trading',
              desc: 'Professional terminal with real-time charts, orderbook and one-click execution.',
              icon: '📈',
            },
            {
              title: 'Bot Library',
              desc: 'Grid, DCA and Trend Following bots running 24/7 on your Hyperliquid account.',
              icon: '🤖',
            },
            {
              title: '100% Free',
              desc: 'No subscription. We earn a small commission on your trades via Hyperliquid affiliate program.',
              icon: '✦',
            },
          ].map(({ title, desc, icon }) => (
            <div
              key={title}
              className="rounded-xl p-6 border transition-colors hover:border-teal-500/30"
              style={{ backgroundColor: '#0d0d14', borderColor: '#1a1a2e' }}
            >
              <div className="text-2xl mb-4">{icon}</div>
              <h3 className="font-bold text-white mb-2">{title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="px-6 pb-24 max-w-3xl mx-auto w-full text-center">
        <h2 className="text-2xl font-black text-white mb-12">How it works</h2>
        <div className="flex flex-col md:flex-row gap-8">
          {[
            {
              step: '1',
              title: 'Connect your wallet',
              desc: 'Sign in with MetaMask or any Web3 wallet.',
            },
            {
              step: '2',
              title: 'Create your Hyperliquid account',
              desc: 'Via our affiliate link (free).',
            },
            {
              step: '3',
              title: 'Start trading or deploy a bot',
              desc: 'Manual or fully automated.',
            },
          ].map(({ step, title, desc }) => (
            <div key={step} className="flex-1 flex flex-col items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center font-black text-sm"
                style={{ backgroundColor: '#00d4aa1a', color: '#00d4aa', border: '1px solid #00d4aa44' }}
              >
                {step}
              </div>
              <h3 className="font-semibold text-white text-sm">{title}</h3>
              <p className="text-xs text-gray-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="mt-auto border-t border-white/5 px-6 py-5 text-center text-xs text-gray-600">
        © 2026 HyperSoftTrade · Free platform · Revenue via affiliate trading fees
      </footer>
    </div>
  );
}
