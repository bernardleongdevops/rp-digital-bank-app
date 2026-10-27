/**
 * Fail-fast, server-only environment configuration for the Banking_App.
 *
 * This module reads every Environment_Config value, applies the documented
 * local defaults, validates them at startup, and exposes a typed accessor.
 *
 * Design notes (Requirement 7):
 *  - The validation logic is a pure function (`validateEnv`) that takes an
 *    env-like object and returns a list of errors. This keeps it fully
 *    unit-/property-testable (task 1.4) without touching `process.env`.
 *  - `loadConfig` applies defaults, runs validation, and throws a
 *    `ConfigError` naming every offending variable (7.6 missing/empty, 7.7
 *    malformed URL) so startup aborts before any request is served.
 *  - `getConfig` is the memoized runtime accessor that reads `process.env`.
 *  - Secrets (`SANDBOX_API_KEY`, `NEXTAUTH_SECRET`) are server-only and are
 *    intentionally NOT prefixed with `NEXT_PUBLIC_`, so they are never inlined
 *    into the client bundle (7.4 security posture).
 *  - No literal gateway/issuer/key values live in application source; the only
 *    URLs/ids present here are the documented LOCAL DEFAULTS permitted by
 *    Requirement 7.1/7.2 for local use (not hardcoded production endpoints).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A readonly view of the environment, as provided by `process.env`. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** The fully-resolved, validated configuration object. */
export interface AppConfig {
  /** Canonical app URL / OIDC redirect base. Server-only. */
  readonly nextAuthUrl: string;
  /** App URL exposed to the browser for display/links only. Public. */
  readonly appUrl: string;
  /** Session / JWT encryption secret. Server-only, no default. */
  readonly nextAuthSecret: string;
  /** OIDC issuer for the Keycloak realm. Server-only. */
  readonly keycloakIssuer: string;
  /** OIDC public client id. Server-only. */
  readonly keycloakClientId: string;
  /** Sandbox gateway versioned base path. Server-only. */
  readonly sandboxApiBaseUrl: string;
  /** Sandbox API key sent as `X-Sandbox-Key`. Server-only secret. */
  readonly sandboxApiKey: string;
}

/** The kind of validation failure encountered for a variable. */
export type ConfigErrorKind = 'missing' | 'malformed-url';

/** A single validation failure, naming the offending variable. */
export interface ConfigValidationError {
  /** The environment variable name, e.g. `SANDBOX_API_BASE_URL`. */
  readonly variable: string;
  readonly kind: ConfigErrorKind;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Variable catalogue (names only — no secret values live in source)
// ---------------------------------------------------------------------------

/**
 * The environment variable names, keyed by their position in the resolved
 * config. Centralised so validation, defaults, and resolution stay in sync.
 */
export const ENV_VARS = {
  nextAuthUrl: 'NEXTAUTH_URL',
  appUrl: 'NEXT_PUBLIC_APP_URL',
  nextAuthSecret: 'NEXTAUTH_SECRET',
  keycloakIssuer: 'KEYCLOAK_ISSUER',
  keycloakClientId: 'KEYCLOAK_CLIENT_ID',
  sandboxApiBaseUrl: 'SANDBOX_API_BASE_URL',
  sandboxApiKey: 'SANDBOX_API_KEY',
} as const;

type ConfigKey = keyof typeof ENV_VARS;

/**
 * Documented LOCAL defaults (Requirement 7.1/7.2 and the design env-var
 * table). These are convenience values for local development only; any
 * variable without a default here is strictly required with no fallback.
 * `NEXTAUTH_SECRET` has no default — it must always be supplied.
 */
export const LOCAL_DEFAULTS: Readonly<Partial<Record<ConfigKey, string>>> = {
  nextAuthUrl: 'http://localhost:3000',
  appUrl: 'http://localhost:3000',
  keycloakIssuer: 'http://localhost:8080/realms/digital-bank',
  keycloakClientId: 'sandbox-web',
  sandboxApiBaseUrl: 'http://localhost:8081/api/v1',
  sandboxApiKey: 'demo-key-123',
} as const;

/** Config keys whose resolved value must be a well-formed URL (7.7). */
export const URL_VARS: readonly ConfigKey[] = [
  'nextAuthUrl',
  'appUrl',
  'keycloakIssuer',
  'sandboxApiBaseUrl',
] as const;

/** All config keys, in declaration order. */
const CONFIG_KEYS = Object.keys(ENV_VARS) as ConfigKey[];

// ---------------------------------------------------------------------------
// Pure resolution + validation (unit-/property-testable)
// ---------------------------------------------------------------------------

/**
 * Resolve each config key from the supplied env, applying local defaults.
 * Returns a map of config key -> resolved string (or undefined when neither
 * the env nor a default supplies a value). This performs NO validation.
 */
export function resolveEnv(env: EnvLike): Record<ConfigKey, string | undefined> {
  const out = {} as Record<ConfigKey, string | undefined>;
  for (const key of CONFIG_KEYS) {
    const raw = env[ENV_VARS[key]];
    const resolved = raw !== undefined && raw !== '' ? raw : LOCAL_DEFAULTS[key];
    out[key] = resolved;
  }
  return out;
}

/** True when a value is a well-formed absolute URL. */
function isWellFormedUrl(value: string): boolean {
  try {
    // The WHATWG URL parser requires an absolute URL; this rejects empty
    // strings, bare hostnames, and other malformed inputs.
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Pure validation of an env-like object (Requirement 7.6, 7.7).
 *
 * Applies local defaults first, then reports:
 *  - every required variable that resolves to missing/empty (`missing`), and
 *  - every URL-valued variable whose resolved value is malformed
 *    (`malformed-url`).
 *
 * Returns an empty array when the configuration is valid. Never throws, so it
 * is safe to call from tests with arbitrary generated inputs.
 */
export function validateEnv(env: EnvLike): ConfigValidationError[] {
  const resolved = resolveEnv(env);
  const errors: ConfigValidationError[] = [];

  for (const key of CONFIG_KEYS) {
    const name = ENV_VARS[key];
    const value = resolved[key];

    if (value === undefined || value === '') {
      errors.push({
        variable: name,
        kind: 'missing',
        message: `Required environment variable ${name} is missing or empty.`,
      });
      continue; // A missing value cannot also be malformed.
    }

    if (URL_VARS.includes(key) && !isWellFormedUrl(value)) {
      errors.push({
        variable: name,
        kind: 'malformed-url',
        message: `Environment variable ${name} is not a well-formed URL: "${value}".`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// ConfigError + loader
// ---------------------------------------------------------------------------

/**
 * Thrown when startup configuration is invalid. Carries the full list of
 * offending variables so the operator sees every problem at once rather than
 * fixing them one at a time.
 */
export class ConfigError extends Error {
  readonly errors: readonly ConfigValidationError[];

  constructor(errors: readonly ConfigValidationError[]) {
    const detail = errors
      .map((e) => `  - ${e.variable}: ${e.message}`)
      .join('\n');
    super(
      `Invalid Banking_App environment configuration. ` +
        `Aborting startup; fix the following ${errors.length} ` +
        `variable(s) and restart:\n${detail}`,
    );
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/**
 * Build a validated {@link AppConfig} from an env-like object.
 *
 * Applies local defaults, validates (7.6/7.7), and throws a {@link ConfigError}
 * naming every offending variable when invalid — the fail-fast behaviour that
 * aborts startup before any request is served. On success, returns a frozen,
 * typed config object.
 */
export function loadConfig(env: EnvLike): AppConfig {
  const errors = validateEnv(env);
  if (errors.length > 0) {
    throw new ConfigError(errors);
  }

  const resolved = resolveEnv(env) as Record<ConfigKey, string>;
  return Object.freeze({
    nextAuthUrl: resolved.nextAuthUrl,
    appUrl: resolved.appUrl,
    nextAuthSecret: resolved.nextAuthSecret,
    keycloakIssuer: resolved.keycloakIssuer,
    keycloakClientId: resolved.keycloakClientId,
    sandboxApiBaseUrl: resolved.sandboxApiBaseUrl,
    sandboxApiKey: resolved.sandboxApiKey,
  });
}

// ---------------------------------------------------------------------------
// Server-only runtime accessor (memoized)
// ---------------------------------------------------------------------------

/**
 * Guard against importing this module into client-side code. The secret
 * variables resolved here (`SANDBOX_API_KEY`, `NEXTAUTH_SECRET`) are
 * server-only and must never reach the browser bundle. The pure functions
 * above remain usable in any environment (including tests); only the runtime
 * `process.env` accessor is gated.
 */
function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'lib/server/config is server-only and must not be imported from client code.',
    );
  }
}

let cachedConfig: AppConfig | null = null;

/**
 * Typed accessor for the validated application configuration.
 *
 * Reads from `process.env` on first call, validates fail-fast, memoizes the
 * result, and returns the typed {@link AppConfig}. Subsequent calls return the
 * cached value. Throws {@link ConfigError} if the environment is invalid and a
 * plain error if invoked from a browser context.
 */
export function getConfig(): AppConfig {
  assertServerOnly();
  if (cachedConfig === null) {
    cachedConfig = loadConfig(process.env);
  }
  return cachedConfig;
}

/**
 * Reset the memoized config. Intended for tests that need to re-evaluate the
 * environment; not used by application code.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
