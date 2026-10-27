# RP Digital Bank — Banking_App

A customer-facing digital banking web application built with **Next.js 14 (App
Router, TypeScript)**. It is a pure HTTP client of the independently deployed
**RP Digital Bank Sandbox**: it implements no banking business logic and holds no
ledger state. All sandbox calls are made server-side through a Backend-for-Frontend
(BFF) layer so the OIDC access token and the sandbox API key never reach the browser.

## Requirements

- **Node.js 18.18.0 or later** (see the `engines` field in `package.json`). Node 20 LTS is recommended.
- npm (ships with Node.js).
- A running instance of the RP Digital Bank Sandbox (gateway + Keycloak). See step 1 below.

## Getting started

The sandbox must be running **before** the Banking_App, because the app depends on
the gateway and Keycloak at runtime for authentication and data.

1. **Start the sandbox first.** In the sandbox repository, bring it up (for example
   `docker compose up --build`, or run it natively). Confirm the gateway is reachable
   at `http://localhost:8081` and Keycloak at `http://localhost:8080` before continuing.

2. **Install dependencies** (in this repository):

   ```bash
   npm install
   ```

3. **Create your local environment file.** Copy the example and adjust values as needed:

   ```bash
   cp .env.local.example .env.local
   ```

   Then set a real value for `NEXTAUTH_SECRET` (for example `openssl rand -base64 32`).
   The defaults for the sandbox URLs and `SANDBOX_API_KEY` match a local sandbox out of
   the box. `.env.local` is gitignored and must never be committed.

4. **Run the Banking_App on port 3000:**

   ```bash
   npm run dev
   ```

   The app binds to **TCP port 3000** (`next dev -p 3000`). Port 3000 is required so
   that Keycloak OIDC redirects and the sandbox CORS allow-list succeed with no extra
   sandbox configuration — `http://localhost:3000` is a registered redirect URI and
   allowed origin on the `sandbox-web` client. Open http://localhost:3000 in a browser.

   To run a production build on port 3000 instead:

   ```bash
   npm run build
   npm run start
   ```

## Environment variables

Every required variable is documented in [`.env.local.example`](./.env.local.example).
Summary:

| Variable | Scope | Purpose |
|----------|-------|---------|
| `NEXTAUTH_URL` | server | Canonical app URL / OIDC redirect base (`http://localhost:3000`). |
| `NEXT_PUBLIC_APP_URL` | public | App URL available to the client for display/links only. |
| `NEXTAUTH_SECRET` | server | Session/JWT encryption secret (required, no default). |
| `KEYCLOAK_ISSUER` | server | OIDC issuer (`http://localhost:8080/realms/digital-bank`). |
| `KEYCLOAK_CLIENT_ID` | server | OIDC client id (`sandbox-web`). |
| `SANDBOX_API_BASE_URL` | server | Sandbox gateway base path (`http://localhost:8081/api/v1`). |
| `SANDBOX_API_KEY` | server only (secret) | Value of the `X-Sandbox-Key` header. Never prefix with `NEXT_PUBLIC_`. |

## Available scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start the development server on port 3000. |
| `npm run build` | Create a production build. |
| `npm run start` | Serve the production build on port 3000. |
| `npm run lint` | Run ESLint. |
| `npm run type-check` | Run the TypeScript compiler with `--noEmit`. |
| `npm run test` | Run the test suite (Vitest). |

## Test users

The sandbox seeds test users (all with password `password`): `alice`, `bob`, and
`instructor`. See the sandbox integration contract (`INTEGRATION_WITH_BANK.md`) for
details on seeded accounts and API behavior.
