export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-gray-950 text-gray-100">
      <div className="text-center space-y-6 px-4">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-emerald-500 flex items-center justify-center">
            <span className="text-gray-950 font-black text-lg">H</span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight">HyperSoftTrade</h1>
        </div>

        <p className="text-xl text-gray-400 max-w-md">
          Professional crypto trading terminal powered by{' '}
          <span className="text-emerald-400 font-semibold">Hyperliquid DEX</span>.
        </p>

        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-sm font-medium">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Coming Soon
        </div>

        <p className="text-gray-600 text-sm">
          Free platform · Revenue via affiliate trading fees
        </p>
      </div>
    </main>
  );
}
