/**
 * Currency_Formatter (Requirement 8.4-8.8, design "Shared utilities and layout",
 * Correctness Property 6).
 *
 * A pure, framework-free module safe for both server and client code. It holds
 * no secrets, imports no React, and carries no `'use client'` / `'use server'`
 * directive so it can be imported from anywhere.
 *
 * It replaces the two duplicated inline `formatCurrency` helpers previously
 * living in `DashboardClient` and `StatementClient`, and hardens them for the
 * determinism and totality guarantees required by Requirement 8.6-8.8.
 */

/**
 * Fixed placeholder rendered when the amount is null, undefined, or not a
 * finite number (Requirement 8.7). A single shared constant guarantees every
 * view renders the identical placeholder.
 */
export const AMOUNT_PLACEHOLDER = '—';

/**
 * The FIXED locale used for every currency rendering. It is passed explicitly
 * to `Intl.NumberFormat` so output never depends on the Browser_Client host
 * locale and is therefore character-for-character identical across every view,
 * every invocation, and every host (Requirement 8.6). `'en-SG'` matches the
 * locale the existing Dashboard formatter used.
 */
const FIXED_LOCALE = 'en-SG';

/**
 * Format a numeric amount together with a currency code into a stable display
 * string.
 *
 * - **Deterministic** (Requirement 8.6): a fixed locale is always used, never
 *   the host locale, so the same `(amount, currency)` renders identically
 *   everywhere and on every call.
 * - **Total / never throws** (Requirement 8.7, 8.8):
 *   - A `null`, `undefined`, or non-finite amount returns {@link AMOUNT_PLACEHOLDER}.
 *   - An empty or non-ISO-4217 currency code (which makes `Intl.NumberFormat`
 *     throw) is caught and the numeric amount is rendered with the provided
 *     code shown verbatim as the indicator, mirroring the previous
 *     `${amount.toFixed(2)} ${currency}` fallback.
 */
export function formatCurrency(
  amount: number | null | undefined,
  currency: string,
): string {
  // Bad amount (null/undefined/NaN/±Infinity) → fixed placeholder, no throw.
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return AMOUNT_PLACEHOLDER;
  }

  try {
    return new Intl.NumberFormat(FIXED_LOCALE, {
      style: 'currency',
      currency,
    }).format(amount);
  } catch {
    // Empty / non-ISO-4217 code: render the amount with the code verbatim.
    return `${amount.toFixed(2)} ${currency}`;
  }
}
