import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        // Trading terminal palette
        terminal: {
          bg: '#030712',       // gray-950
          surface: '#111827',  // gray-900
          border: '#1f2937',   // gray-800
          muted: '#6b7280',    // gray-500
        },
        buy: '#10b981',   // emerald-500
        sell: '#ef4444',  // red-500
      },
      fontFamily: {
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui'],
      },
    },
  },
  plugins: [],
};

export default config;
