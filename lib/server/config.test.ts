import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ENV_VARS,
  LOCAL_DEFAULTS,
  URL_VARS,
  resolveEnv,
  validateEnv,
  loadConfig,
  ConfigError,
  type EnvLike,
} from './config';

/**
 * Feature: customer-banking-app, Property 6: Config integrity (fail-fast)
 *
 * For any Environment_Config in which a required variable is missing/empty, or
 * in which a URL-valued variable is malformed, the Banking_App aborts startup
 * (loadConfig throws a ConfigError) and reports every offending variable by
 * name. For any fully-valid config, startup succeeds (validateEnv returns [] and
 * loadConfig returns a frozen typed config with the resolved values).
 *
 * Validates: Requirements 7.6, 7.7
 *
 * These tests exercise the pure functions (resolveEnv / validateEnv / loadConfig)
 * with an env-like object, so no process.env or server APIs are touched.
 */

type ConfigKey = keyof typeof ENV_VARS;

const CONFIG_KEYS = Object.keys(ENV_VARS) as ConfigKey[];
// Keys that have NO local default → strictly required with no fallback.
const KEYS_WITHOUT_DEFAULT = CONFIG_KEYS.filter(
  (k) => LOCAL_DEFAULTS[k] === undefined,
);

const NUM_RUNS = 200;

/** A valid, well-formed URL value for URL-valued vars. */
const validUrlArb = fc
  .webUrl({ validSchemes: ['http', 'https'] })
  .filter((u) => {
    // The config's isWellFormedUrl requires http/https protocol. webUrl can
    // occasionally produce values the WHATWG parser normalizes oddly; keep only
    // what the module itself would accept.
    try {
      const p = new URL(u);
      return p.protocol === 'http:' || p.protocol === 'https:';
    } catch {
      return false;
    }
  });

/** A non-empty, non-URL string value (for non-URL vars like secrets/ids). */
const nonEmptyStringArb = fc.string({ minLength: 1 }).filter((s) => s !== '');

/** Build a fully-valid env (every var present, non-empty, URLs well-formed). */
const validEnvArb: fc.Arbitrary<Record<string, string>> = fc
  .record({
    nextAuthUrl: validUrlArb,
    appUrl: validUrlArb,
    nextAuthSecret: nonEmptyStringArb,
    keycloakIssuer: validUrlArb,
    keycloakClientId: nonEmptyStringArb,
    sandboxApiBaseUrl: validUrlArb,
    sandboxApiKey: nonEmptyStringArb,
  })
  .map((vals) => {
    const env: Record<string, string> = {};
    for (const key of CONFIG_KEYS) {
      env[ENV_VARS[key]] = vals[key];
    }
    return env;
  });

describe('config integrity (fail-fast) — Property 6', () => {
  // -------------------------------------------------------------------------
  // Totality / determinism of validateEnv
  // -------------------------------------------------------------------------
  it('validateEnv never throws for arbitrary string env inputs (totality)', () => {
    const anyEnvArb = fc.dictionary(
      fc.string(),
      fc.oneof(fc.string(), fc.constant(undefined)),
    ) as fc.Arbitrary<EnvLike>;

    fc.assert(
      fc.property(anyEnvArb, (env) => {
        expect(() => validateEnv(env)).not.toThrow();
        const errs = validateEnv(env);
        expect(Array.isArray(errs)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('validateEnv is deterministic (same input → same errors)', () => {
    const anyEnvArb = fc.dictionary(
      fc.string(),
      fc.oneof(fc.string(), fc.constant(undefined)),
    ) as fc.Arbitrary<EnvLike>;

    fc.assert(
      fc.property(anyEnvArb, (env) => {
        expect(validateEnv(env)).toEqual(validateEnv(env));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Valid config → clean startup
  // -------------------------------------------------------------------------
  it('fully-valid env: validateEnv returns [] and loadConfig returns a frozen typed config', () => {
    fc.assert(
      fc.property(validEnvArb, (env) => {
        expect(validateEnv(env)).toEqual([]);

        const config = loadConfig(env);
        expect(Object.isFrozen(config)).toBe(true);

        // Resolved values equal the supplied raw values.
        expect(config.nextAuthUrl).toBe(env[ENV_VARS.nextAuthUrl]);
        expect(config.appUrl).toBe(env[ENV_VARS.appUrl]);
        expect(config.nextAuthSecret).toBe(env[ENV_VARS.nextAuthSecret]);
        expect(config.keycloakIssuer).toBe(env[ENV_VARS.keycloakIssuer]);
        expect(config.keycloakClientId).toBe(env[ENV_VARS.keycloakClientId]);
        expect(config.sandboxApiBaseUrl).toBe(env[ENV_VARS.sandboxApiBaseUrl]);
        expect(config.sandboxApiKey).toBe(env[ENV_VARS.sandboxApiKey]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Defaults applied only when the raw value is absent/empty
  // -------------------------------------------------------------------------
  it('defaults are applied only when the raw value is absent or empty', () => {
    // For each key with a default, drive the raw value through absent/empty/present.
    const rawArb = fc.oneof(
      fc.constant(undefined), // absent
      fc.constant(''), // empty
      nonEmptyStringArb, // present
    );

    fc.assert(
      fc.property(
        fc.record(
          Object.fromEntries(CONFIG_KEYS.map((k) => [k, rawArb])) as Record<
            ConfigKey,
            fc.Arbitrary<string | undefined>
          >,
        ),
        (raws) => {
          const env: EnvLike = Object.fromEntries(
            CONFIG_KEYS.flatMap((k) =>
              raws[k] === undefined ? [] : [[ENV_VARS[k], raws[k]]],
            ),
          );
          const resolved = resolveEnv(env);

          for (const key of CONFIG_KEYS) {
            const raw = raws[key];
            if (raw !== undefined && raw !== '') {
              // Present: raw value wins, default never applied.
              expect(resolved[key]).toBe(raw);
            } else {
              // Absent/empty: falls back to default (or undefined if none).
              expect(resolved[key]).toBe(LOCAL_DEFAULTS[key]);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Missing/empty required var → reported by name + loadConfig throws
  // -------------------------------------------------------------------------
  it('any required var forced missing/empty (no default) is reported by name and loadConfig throws', () => {
    // Start from a valid env, then blank out an arbitrary non-empty subset of
    // the keys that have no default (so blanking them truly removes the value).
    const subsetArb = fc
      .subarray(KEYS_WITHOUT_DEFAULT, { minLength: 1 })
      .filter((s) => s.length > 0);

    fc.assert(
      fc.property(
        validEnvArb,
        subsetArb,
        fc.constantFrom<'' | 'absent'>('', 'absent'),
        (validEnv, keysToBreak, mode) => {
          const env: Record<string, string | undefined> = { ...validEnv };
          for (const key of keysToBreak) {
            if (mode === '') {
              env[ENV_VARS[key]] = '';
            } else {
              delete env[ENV_VARS[key]];
            }
          }

          const errors = validateEnv(env);
          const brokenNames = keysToBreak.map((k) => ENV_VARS[k]);

          // Every broken var is reported as 'missing' by name.
          for (const name of brokenNames) {
            const match = errors.find(
              (e) => e.variable === name && e.kind === 'missing',
            );
            expect(match).toBeDefined();
            expect(match?.message).toContain(name);
          }

          // loadConfig throws a ConfigError naming every offending variable.
          let thrown: unknown;
          try {
            loadConfig(env);
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(ConfigError);
          const configError = thrown as ConfigError;
          for (const name of brokenNames) {
            expect(configError.errors.some((e) => e.variable === name)).toBe(
              true,
            );
            expect(configError.message).toContain(name);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Malformed URL var → reported by name + loadConfig throws
  // -------------------------------------------------------------------------
  it('any URL-valued var set to a malformed URL is reported by name and loadConfig throws', () => {
    // Non-empty strings that are NOT well-formed http/https URLs.
    const malformedUrlArb = fc
      .string({ minLength: 1 })
      .filter((s) => {
        if (s === '') return false;
        try {
          const p = new URL(s);
          return !(p.protocol === 'http:' || p.protocol === 'https:');
        } catch {
          return true; // unparseable → malformed, good
        }
      });

    const subsetArb = fc
      .subarray(URL_VARS as ConfigKey[], { minLength: 1 })
      .filter((s) => s.length > 0);

    fc.assert(
      fc.property(
        validEnvArb,
        subsetArb,
        malformedUrlArb,
        (validEnv, urlKeysToBreak, badUrl) => {
          const env: Record<string, string> = { ...validEnv };
          for (const key of urlKeysToBreak) {
            env[ENV_VARS[key]] = badUrl;
          }

          const errors = validateEnv(env);
          const brokenNames = urlKeysToBreak.map((k) => ENV_VARS[k]);

          for (const name of brokenNames) {
            const match = errors.find(
              (e) => e.variable === name && e.kind === 'malformed-url',
            );
            expect(match).toBeDefined();
            expect(match?.message).toContain(name);
          }

          let thrown: unknown;
          try {
            loadConfig(env);
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(ConfigError);
          for (const name of brokenNames) {
            expect(
              (thrown as ConfigError).errors.some((e) => e.variable === name),
            ).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // A missing value is never also reported as malformed (no double-report)
  // -------------------------------------------------------------------------
  it('a variable is never reported both missing and malformed-url', () => {
    const anyEnvArb = fc.dictionary(
      fc.constantFrom(...CONFIG_KEYS.map((k) => ENV_VARS[k])),
      fc.oneof(fc.string(), fc.constant(undefined)),
    ) as fc.Arbitrary<EnvLike>;

    fc.assert(
      fc.property(anyEnvArb, (env) => {
        const errors = validateEnv(env);
        const byVar = new Map<string, Set<string>>();
        for (const e of errors) {
          const set = byVar.get(e.variable) ?? new Set<string>();
          set.add(e.kind);
          byVar.set(e.variable, set);
        }
        for (const [, kinds] of byVar) {
          expect(kinds.has('missing') && kinds.has('malformed-url')).toBe(
            false,
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
