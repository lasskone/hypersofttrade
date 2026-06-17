'use client';

/**
 * AffiliateGate — placeholder component
 *
 * This component will enforce that users register on Hyperliquid
 * through the affiliate referral code before accessing the platform.
 * Revenue model: affiliate commission on trading fees.
 *
 * Referral code: process.env.NEXT_PUBLIC_HYPERLIQUID_REFERRAL_CODE (KNS)
 */
export function AffiliateGate({ children }: { children: React.ReactNode }) {
  // TODO: check if wallet has registered via referral code KNS
  // If not, show referral registration UI before granting access
  return <>{children}</>;
}
