/**
 * Author's Voice wallet helpers — thin client wrappers over the openwriter server's
 * proxied AV billing routes (plugins/authors-voice injects the server-side AV key; the
 * browser never talks to api.authors-voice.com directly).
 *
 * Framing is locked: dollars + approximate per-model ¢ (each edit bills its real model cost ×
 * the API's margin multiplier, so it varies with length), never "credits". Balance is in cents.
 */
import { showToast } from './toast';

export interface TopupOption {
  priceId: string;
  amountCents: number;
  amountDollars: number;
}

export interface WalletBilling {
  wallet: { balanceCents: number } | null;
  usage?: unknown;
  billing?: unknown;
}

/** Cents → "$4.30" (always two decimals). */
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** GET the wallet/usage snapshot. Returns null on any failure (caller shows nothing). */
export async function fetchWalletBilling(): Promise<WalletBilling | null> {
  try {
    const res = await fetch('/api/voice/billing');
    if (!res.ok) return null;
    return (await res.json()) as WalletBilling;
  } catch {
    return null;
  }
}

/** GET the top-up catalog ($5/$10/$20). Returns [] on any failure. */
export async function fetchTopupOptions(): Promise<TopupOption[]> {
  try {
    const res = await fetch('/api/voice/billing/topup-options');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.options) ? (data.options as TopupOption[]) : [];
  } catch {
    return [];
  }
}

/**
 * Start a Stripe top-up: POST the dollar amount, open the returned checkout URL in a new tab.
 * Toasts on failure so an imperative caller (the failure-toast "Top up" button) isn't a dead end.
 */
export async function openTopupCheckout(amount: 5 | 10 | 20): Promise<void> {
  try {
    const res = await fetch('/api/voice/billing/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) {
      showToast('Could not start top-up. Please try again.', 'error');
      return;
    }
    const data = await res.json();
    if (data?.url) window.open(data.url, '_blank');
    else showToast('Could not start top-up. Please try again.', 'error');
  } catch {
    showToast('Could not start top-up. Please try again.', 'error');
  }
}
