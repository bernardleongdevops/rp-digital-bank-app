/**
 * Next.js instrumentation hook.
 *
 * `register()` runs once when the server process starts, before any request is
 * served. We use it to perform fail-fast validation of the Environment_Config
 * (Requirement 7.6, 7.7): if any required variable is missing/empty or any
 * URL-valued variable is malformed, `getConfig()` throws a `ConfigError` that
 * names every offending variable, aborting startup.
 */
export async function register(): Promise<void> {
  // Only validate in the Node.js server runtime; skip the edge runtime where
  // server-only secrets are not resolved.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getConfig } = await import('./lib/server/config');
    getConfig();
  }
}
