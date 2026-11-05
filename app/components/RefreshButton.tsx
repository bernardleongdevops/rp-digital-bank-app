'use client';

/**
 * Shared Manual_Refresh control (Requirements 1.4, 1.5, 1.6, 1.7, 1.8).
 *
 * A reusable button wired by the Dashboard and Statement_View (task 5.1) to
 * re-initiate a view's data request(s) on demand without a full page reload
 * (Requirements 1.4, 1.5). The button itself owns NO data: it only invokes the
 * supplied `onRefresh` loader and manages the single-flight / in-flight UI
 * concern. The parent view is responsible for replacing data on success and
 * retaining prior data with an error+retry on failure (Requirements 1.7, 1.8);
 * that wiring is task 5.1.
 *
 * Single-flight guard (Requirement 1.6, design Property 11): WHILE a refresh is
 * in flight the control disables itself so AT MOST ONE outbound refresh is
 * issued per completed cycle. The guard is enforced SYNCHRONOUSLY via a ref —
 * not only via the `disabled` attribute — so a rapid double-click that fires a
 * second `onClick` before React re-renders cannot start a second refresh. This
 * mirrors the Transfer_Form `SubmitGuard` (v1 Property 7); the framework-free
 * core lives in `lib/refreshGuard.ts` (`RefreshGuard`) so it is unit/property
 * testable without mounting React.
 *
 * Observability (Requirement 1.6): the loading affordance is driven by React
 * state set at the start of the cycle, so it is observable from the next paint
 * (well within 300 ms, no artificial delay) — the control becomes `disabled`,
 * exposes `aria-busy="true"`, and shows a "Refreshing…" label.
 *
 * Re-enable on settle (Requirements 1.7, 1.8): the in-flight flag is cleared in
 * a `finally` block, so the control is re-enabled whether the refresh resolves
 * or rejects. A `RefreshButton` unmounted mid-flight does not set state after
 * unmount.
 *
 * No secrets, no gateway URLs, no server-only imports.
 */

import { useEffect, useRef, useState } from 'react';

import { RefreshGuard } from '@/lib/refreshGuard';

export interface RefreshButtonProps {
  /**
   * The region loader to re-invoke. May be async; the control stays disabled
   * until the returned promise settles. Synchronous loaders are also supported
   * (a non-promise return re-enables the control on the next microtask).
   */
  onRefresh: () => Promise<void> | void;
  /** Idle label for the control. */
  label?: string;
  /** Label shown WHILE a refresh is in flight. */
  refreshingLabel?: string;
  /**
   * Externally disable the control (e.g. while the initial load is still
   * running). The control is disabled when this is true OR a refresh is in
   * flight.
   */
  disabled?: boolean;
  className?: string;
}

export function RefreshButton({
  onRefresh,
  label = 'Refresh',
  refreshingLabel = 'Refreshing…',
  disabled = false,
  className,
}: RefreshButtonProps) {
  // `refreshing` drives rendering (disabled + aria-busy + label). The guard is
  // the synchronous source of truth that prevents a second refresh starting
  // before this state update causes a re-render.
  const [refreshing, setRefreshing] = useState(false);
  const guardRef = useRef<RefreshGuard>(new RefreshGuard());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleClick() {
    // Synchronous single-flight gate: if a refresh is already in flight, this
    // activation is ignored entirely (no second outbound refresh).
    if (!guardRef.current.begin()) return;

    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // The button does not own data or error presentation; the parent view
      // handles retain-prior-data + error+retry on failure (task 5.1). We only
      // swallow here so the control is still re-enabled below.
    } finally {
      guardRef.current.end();
      if (mountedRef.current) setRefreshing(false);
    }
  }

  const isDisabled = disabled || refreshing;

  return (
    <button
      type="button"
      className={className}
      disabled={isDisabled}
      aria-busy={refreshing}
      aria-live="polite"
      onClick={() => {
        void handleClick();
      }}
    >
      {refreshing ? refreshingLabel : label}
    </button>
  );
}
