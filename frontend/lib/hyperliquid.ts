/**
 * Hyperliquid API client — placeholder
 *
 * Will wrap calls to the Hyperliquid REST & WebSocket APIs.
 * Backend at NEXT_PUBLIC_API_URL proxies authenticated requests.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://hypersofttrade-backend-production.up.railway.app';
const REFERRAL_CODE = process.env.NEXT_PUBLIC_HYPERLIQUID_REFERRAL_CODE ?? 'KNS';

export const hyperliquid = {
  referralCode: REFERRAL_CODE,

  /** Fetch account info for a given wallet address */
  async getAccountInfo(address: string) {
    const res = await fetch(`${API_URL}/account/${address}`);
    if (!res.ok) throw new Error('Failed to fetch account info');
    return res.json();
  },

  /** Fetch open positions */
  async getPositions(address: string) {
    const res = await fetch(`${API_URL}/account/${address}/positions`);
    if (!res.ok) throw new Error('Failed to fetch positions');
    return res.json();
  },

  /** Placeholder: place an order */
  async placeOrder(_payload: Record<string, unknown>) {
    // TODO: implement via backend /orders/place
    throw new Error('Not implemented');
  },
};
