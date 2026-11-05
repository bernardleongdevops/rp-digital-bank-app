/**
 * Manual_Refresh single-flight plumbing shared by the refreshable views
 * (task 4.5, Requirement 1.6).
 *
 * This module is intentionally free of React and of any server-only import so
 * it can be exercised directly by the Property 11 "Manual_Refresh single-flight
 * guard" test (task 4.6) without mounting a component. It mirrors the
 * {@link SubmitGuard} pattern used by the Transfer_Form (v1 Property 7): a
 * tiny, framework-free guard that enforces the in-flight invariant of
 * Requirement 1.6 — WHILE a Manual_Refresh request is in progress the refresh
 * control is disabled so a rapid double-activation issues AT MOST ONE outbound
 * refresh per completed refresh cycle.
 *
 * The React {@link RefreshButton} derives its disabled state from the same
 * in-flight flag this guard tracks, so the guard is the single source of truth
 * for "is a refresh in flight". Because the guard is a plain object, task 4.6
 * can drive it through arbitrary activation sequences and assert that
 * `begin()` grants permission at most once per cycle.
 *
 * No secrets, no gateway URLs.
 */

/**
 * A minimal, framework-free in-flight guard enforcing Requirement 1.6.
 *
 * Usage contract:
 *   - `begin()` returns `true` exactly once per refresh cycle — on the first
 *     call while idle — and marks the guard "in flight". Every subsequent
 *     `begin()` while still in flight returns `false` (the activation is
 *     ignored), which is what prevents a rapid double-click from issuing a
 *     second outbound refresh.
 *   - `end()` clears the in-flight flag so the NEXT refresh cycle may begin.
 *     It is called whether the refresh settles with success OR failure so the
 *     control is always re-enabled (Requirements 1.7, 1.8).
 *   - `isInFlight()` exposes the flag so the UI can disable the refresh control
 *     (belt-and-braces alongside the ignored-activation behaviour).
 */
export class RefreshGuard {
  private inFlight = false;

  /**
   * Attempt to start a refresh cycle. Returns `true` and latches in-flight when
   * idle; returns `false` (and changes nothing) when a refresh is already in
   * flight. Callers MUST only issue the outbound refresh when this returns
   * `true`.
   */
  begin(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  /** Release the guard at the end of a refresh cycle (success or failure). */
  end(): void {
    this.inFlight = false;
  }

  /** Whether a refresh is currently in flight. */
  isInFlight(): boolean {
    return this.inFlight;
  }
}
