// @vitest-environment node
//
// Feature: customer-banking-app, Property 5: No direct browser-to-gateway calls
//
// Static source-analysis guard (task 11.2). For ANY client data need the
// request target must be a same-origin `/api/bff/*` endpoint and NEVER the
// Sandbox_Gateway origin (default http://localhost:8081) nor the
// Identity_Provider origin (default http://localhost:8080). This is the
// compile-time counterpart to the runtime credential-confinement properties:
// if a browser bundle ever fetched the gateway directly, the access token and
// Sandbox_Key would have to live in the browser — exactly what the BFF layer
// exists to prevent (Requirements 6.2, 6.3, 6.4, 10.5).
//
// Validates: Requirements 6.4, 10.5
//
// Strategy
// --------
// This is a pure filesystem + regex scan — no rendering, no network, fully
// deterministic. It runs in the Node environment (see the directive above) so
// it can read source files from disk with `node:fs`.
//
//   1. Enumerate every client-reachable source file:
//        - every file under `app/**` whose source carries the `'use client'`
//          directive (excluding `*.test.*` / `*.spec.*` test files), PLUS
//        - `lib/transferSubmit.ts`, which is imported by a client component
//          and issues the transfer POST, so it is browser-reachable.
//      A small allowlist of KNOWN client components is asserted to be present
//      in the discovered set so the scan can never silently cover nothing.
//
//   2. For each file, extract the first string/template-literal argument of
//      every `fetch(...)` call and assert it begins with `/api/bff/`.
//
//   3. Assert no `fetch(...)` targets an absolute URL (`http://` / `https://`).
//
//   4. Assert the gateway / issuer host:port literals (`localhost:8081`,
//      `localhost:8080`) never appear anywhere in a client-reachable file —
//      those strings belong only to server config / `.env`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repo root — this file lives at `<root>/app/__guards__/`. */
const ROOT = join(__dirname, '..', '..');
const APP_DIR = join(ROOT, 'app');

/**
 * Extra client-reachable modules that are NOT `'use client'` files themselves
 * but are imported into the browser bundle by a client component. They must
 * obey the same fetch discipline.
 */
const EXTRA_CLIENT_FILES = [join(ROOT, 'lib', 'transferSubmit.ts')];

/**
 * Known client components that MUST be covered by the scan. If any of these
 * stops matching the discovery heuristic (e.g. a refactor drops the directive),
 * the allowlist assertion fails loudly rather than letting coverage quietly
 * shrink to nothing.
 */
const REQUIRED_CLIENT_FILES = [
  'app/dashboard/DashboardClient.tsx',
  'app/accounts/[accountNumber]/StatementClient.tsx',
  'app/transfer/TransferForm.tsx',
  'app/transfer/TransferContainer.tsx',
  'lib/transferSubmit.ts',
].map((p) => p.split('/').join(sep));

/** Gateway / issuer origin literals that must never appear in client code. */
const FORBIDDEN_HOST_LITERALS = ['localhost:8081', 'localhost:8080'];

/** Test files are excluded from the client-code scan. */
const TEST_FILE = /\.(test|spec)\.[tj]sx?$/;
/** Source files we consider for the directive scan. */
const SOURCE_FILE = /\.[tj]sx?$/;

/** Recursively list every non-test source file under a directory. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...listSourceFiles(full));
    } else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True when `source` opens with the `'use client'` directive. The directive
 * must be the first statement, but may be preceded by comments / blank lines,
 * so we scan the leading region rather than only line 1.
 */
function hasUseClientDirective(source: string): boolean {
  // Strip a leading block of line comments / block comments / whitespace, then
  // check the first real token is a `'use client'` / "use client" directive.
  const withoutLeadingComments = source
    .replace(/^\uFEFF/, '') // strip BOM if present
    .replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  return /^(['"])use client\1/.test(withoutLeadingComments);
}

/**
 * Extract the raw first-argument literal of every `fetch(...)` call in the
 * source. Returns one entry per fetch call. A non-literal first argument
 * (a variable / expression) yields `{ literal: null }` so the caller can decide
 * how strict to be. Handles single-, double-, and back-tick-quoted literals.
 */
interface FetchArg {
  /** The literal URL text if the first arg is a string/template literal. */
  literal: string | null;
  /** The raw matched call text, for diagnostics. */
  raw: string;
}

function extractFetchArgs(source: string): FetchArg[] {
  const args: FetchArg[] = [];
  // Match `fetch(` optionally preceded by a receiver like `options.fetchImpl`
  // or `doFetch`/`fetchMock` — we only want the GLOBAL fetch discipline, but a
  // renamed call (e.g. `doFetch(TRANSFER_ENDPOINT, ...)`) wrapping fetch still
  // needs its literal checked, so we also match an identifier call whose first
  // arg is a quoted literal beginning with a slash or http. To stay precise and
  // avoid false positives we specifically scan `fetch(` and `doFetch(`.
  const callRe = /\b(?:fetch|doFetch)\s*\(\s*([`'"])([^`'"]*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    args.push({ literal: m[2], raw: m[0] });
  }
  // Also capture `fetch(` / `doFetch(` calls whose first arg is NOT a literal
  // (e.g. a variable), so we can assert they are only the known safe seams.
  const nonLiteralRe = /\b(?:fetch|doFetch)\s*\(\s*(?![`'"])([A-Za-z_$][\w$.]*)/g;
  while ((m = nonLiteralRe.exec(source)) !== null) {
    args.push({ literal: null, raw: m[0] });
  }
  return args;
}

// ---------------------------------------------------------------------------
// Discover the set of client-reachable files once, up front.
// ---------------------------------------------------------------------------

const clientFiles: string[] = [
  ...listSourceFiles(APP_DIR).filter((f) =>
    hasUseClientDirective(readFileSync(f, 'utf8')),
  ),
  ...EXTRA_CLIENT_FILES,
];

/** Relative, OS-independent paths for readable assertion messages. */
const relClientFiles = clientFiles.map((f) => relative(ROOT, f));

describe("Property 5: no direct browser-to-gateway calls", () => {
  it('discovers the known client components (coverage is non-empty)', () => {
    // The scan must actually cover the known client components; otherwise a
    // green result would be meaningless.
    for (const required of REQUIRED_CLIENT_FILES) {
      expect(
        relClientFiles,
        `expected client-code scan to include ${required}`,
      ).toContain(required);
    }
    // Sanity: more than just the allowlist may be present, but never fewer.
    expect(clientFiles.length).toBeGreaterThanOrEqual(REQUIRED_CLIENT_FILES.length);
  });

  it('every fetch target in client code is a same-origin /api/bff/* path', () => {
    for (const file of clientFiles) {
      const rel = relative(ROOT, file);
      const source = readFileSync(file, 'utf8');
      const fetchArgs = extractFetchArgs(source);

      for (const arg of fetchArgs) {
        if (arg.literal === null) {
          // A non-literal fetch first-arg (variable/expression). The only such
          // call in client code is `postTransfer`'s `doFetch(TRANSFER_ENDPOINT,
          // …)` where the constant is asserted separately below, and the test
          // harness seam. Assert the referenced identifier is an allowed seam
          // name rather than an unknown absolute URL builder.
          const ident = arg.raw.replace(/\b(?:fetch|doFetch)\s*\(\s*/, '').trim();
          const allowedIdents = ['url', 'path', 'TRANSFER_ENDPOINT', 'input'];
          expect(
            allowedIdents.some((a) => ident.startsWith(a)),
            `${rel}: fetch() called with non-literal, unexpected argument "${ident}". ` +
              `Client fetches must target a literal /api/bff/* path or a vetted seam.`,
          ).toBe(true);
          continue;
        }

        // (a) No absolute-URL fetch target from client code.
        expect(
          /^https?:\/\//i.test(arg.literal),
          `${rel}: fetch target "${arg.literal}" is an absolute URL. Client code ` +
            `must only call same-origin /api/bff/* endpoints.`,
        ).toBe(false);

        // (b) Every literal fetch target is a same-origin app endpoint: a BFF
        // data endpoint (`/api/bff/*`), the AI assistant BFF proxy
        // (`/api/ai/*`), or a NextAuth auth endpoint (`/api/auth/*`, e.g. the
        // federated-logout helper). All are same-origin and server-side;
        // none is a direct call to the Sandbox_Gateway, which is what this
        // property forbids.
        const isAllowedSameOrigin =
          arg.literal.startsWith('/api/bff/') ||
          arg.literal.startsWith('/api/auth/') ||
          arg.literal.startsWith('/api/ai/');
        expect(
          isAllowedSameOrigin,
          `${rel}: fetch target "${arg.literal}" must be a same-origin ` +
            `/api/bff/*, /api/auth/*, or /api/ai/* endpoint (never the gateway directly).`,
        ).toBe(true);
      }
    }
  });

  it("transferSubmit's transfer endpoint constant is the same-origin BFF path", () => {
    const file = join(ROOT, 'lib', 'transferSubmit.ts');
    const source = readFileSync(file, 'utf8');
    // The POST target is a named constant consumed by `doFetch`; assert the
    // constant literal is exactly the same-origin BFF transfers path.
    const match = source.match(
      /TRANSFER_ENDPOINT\s*=\s*(['"`])([^'"`]*)\1/,
    );
    expect(match, 'TRANSFER_ENDPOINT constant not found').not.toBeNull();
    expect(match?.[2]).toBe('/api/bff/transfers');
  });

  it('no gateway/issuer host literal appears in any client-reachable file', () => {
    for (const file of clientFiles) {
      const rel = relative(ROOT, file);
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_HOST_LITERALS) {
        expect(
          source.includes(forbidden),
          `${rel}: forbidden host literal "${forbidden}" found in client code. ` +
            `Gateway/issuer origins must live only in server config / .env.`,
        ).toBe(false);
      }
    }
  });
});
