// Protected route — authentication enforced at middleware level (TODO)
export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded bg-emerald-500 flex items-center justify-center">
            <span className="text-gray-950 font-black">H</span>
          </div>
          <h1 className="text-2xl font-bold">HyperSoftTrade Dashboard</h1>
          <span className="ml-auto px-2 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
            Under Construction
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {['Portfolio', 'Open Positions', 'Active Bots'].map((panel) => (
            <div
              key={panel}
              className="rounded-xl border border-gray-800 bg-gray-900 p-6 flex flex-col gap-2"
            >
              <h2 className="text-sm font-medium text-gray-400">{panel}</h2>
              <p className="text-2xl font-bold text-gray-200">—</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
