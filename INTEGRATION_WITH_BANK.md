# Integrating a client application with the sandbox

This is the canonical contract for building an application (in any language or
framework) on top of the RP Digital Bank Sandbox. Your app is a **client**: it
talks to the sandbox only over HTTP and never shares code with it. The contract
is the API described here plus the OpenAPI document served by the gateway.

> Build client apps in a **separate repository** with their own pipeline. The
> only dependency on the sandbox is at runtime, over HTTP.

## 1. What you connect to

| Thing | URL (local) | Notes |
|-------|-------------|-------|
| API gateway (single entry point) | `http://localhost:8081` | All API calls go here. |
| API base path | `http://localhost:8081/api/v1` | Versioned prefix for every endpoint. |
| Keycloak (identity / OIDC) | `http://localhost:8080` | Login and tokens. |
| OIDC issuer | `http://localhost:8080/realms/digital-bank` | The realm. |

Make these configurable in your app (environment variables), never hardcoded, so
the same build can point at a local or a hosted sandbox later.

## 2. Authentication (OIDC via Keycloak)

- Realm: `digital-bank`
- Client: `sandbox-web` (public SPA client; use **Authorization Code + PKCE** for
  browser apps).
- Registered redirect URIs / allowed web origins: `http://localhost:3000` and
  `http://localhost:5173`. **Run your app on one of these ports** (3000 recommended)
  so login and CORS work with no extra configuration.
- Test users (all password `password`):

| Username | customer_ref | Roles |
|----------|--------------|-------|
| `alice` | `CUST-ALICE` | customer |
| `bob` | `CUST-BOB` | customer |
| `instructor` | `CUST-ALICE` | customer, admin |

### Getting a token directly (handy for scripts / testing)

```bash
curl -X POST "http://localhost:8080/realms/digital-bank/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=sandbox-web&username=alice&password=password"
```

Browser apps should use the standard OIDC Authorization Code + PKCE redirect flow
(e.g. via a library such as `keycloak-js`, `oidc-client-ts`, or NextAuth's Keycloak
provider) rather than the password grant above.

## 3. Required headers on every API call

| Header | Value | Purpose |
|--------|-------|---------|
| `Authorization` | `Bearer <access_token>` | The OIDC access token (JWT). |
| `X-Sandbox-Key` | `demo-key-123` (or `student-key-456`) | Sandbox API key, checked at the gateway. |
| `Content-Type` | `application/json` | For `POST` bodies. |

Missing/invalid key -> `401`. Exceeding the per-key rate limit (60 req/min by
default) -> `429`. Public paths (actuator health, OpenAPI, Swagger) need no key.

## 4. API endpoints (all under `/api/v1`, via the gateway)

The gateway strips the `/api/v1/<service>` prefix and routes to the service.

| Method & path | Description | Owner-scoped |
|---------------|-------------|--------------|
| `GET /api/v1/customers/me` | The signed-in customer's record. | yes (from token) |
| `GET /api/v1/accounts` | List the signed-in customer's accounts. | yes |
| `GET /api/v1/accounts/{accountNumber}` | One owned account by number. | yes (404 if not yours) |
| `GET /api/v1/transactions/accounts/{accountNumber}` | Statement history. Optional `from` / `to` ISO-8601 query params. | yes |
| `POST /api/v1/payments/transfers` | Make an internal transfer. | yes (source must be yours) |

### Transfer request body

```json
{
  "fromAccount": "ACC-1001",
  "toAccount": "ACC-1002",
  "amount": 100.00,
  "description": "pocket money"
}
```

## 5. Response outcomes to handle

Your app should handle each of these explicitly:

| Status | Meaning | When |
|--------|---------|------|
| `200` / `201` | Success (201 on a completed transfer). | Normal path. |
| `202` | **AML held for review** — transfer not applied. | Amount >= review threshold (default 5000). |
| `422` | **AML blocked** — transfer refused. | Amount >= flag threshold (default 10000). |
| `409` | Business conflict (insufficient funds, same account, currency mismatch, invalid amount). | Validation of the transfer. |
| `403` | Forbidden (you do not own the source account; or not an admin for admin routes). | Ownership / role checks. |
| `401` | Unauthenticated (missing/invalid token or API key). | Auth failure. |
| `429` | Rate limit exceeded for your API key. | Too many requests. |

All errors return a consistent JSON body:

```json
{ "timestamp": "...", "status": 409, "error": "INSUFFICIENT_FUNDS", "message": "...", "path": "/..." }
```

## 6. Seeded data to build against

| Customer | Accounts (opening balance) |
|----------|----------------------------|
| CUST-ALICE (alice) | ACC-1001 SAVINGS 5000.00 SGD, ACC-1002 CURRENT 1200.50 SGD |
| CUST-BOB (bob) | ACC-2001 SAVINGS 8300.75 SGD, ACC-2002 CURRENT 450.00 SGD |

The transaction service also ships seeded historical statement entries.

## 7. Interactive reference

- Aggregated API docs (Swagger UI): `http://localhost:8081/swagger-ui.html`
  (pick a service from the dropdown).
- Machine-readable spec per service, via the gateway:
  `http://localhost:8081/v3/api-docs/{customer-service|account-service|transaction-service|payment-service}`
  — useful for generating a typed client.
- A worked end-to-end example client: `reference-app/` in this repo.

## 8. Known v1 behaviour to be aware of

- The **payment service owns its own accounts and ledger** (for atomic transfers),
  so a transfer updates balances/ledger **in the payment service only**. The
  account service and transaction service hold their own seeded data and are not
  synchronized with transfers in v1. This is a deliberate teaching simplification
  (see `.kiro/specs/digital-bank-sandbox/design.md`). A future version would
  reconcile the services via the `PaymentCompletedEvent`.

## 9. Typical client checklist

1. Start the sandbox (`docker compose up --build`, or run natively).
2. Configure your app with the gateway URL, issuer URL, client id, and API key
   (from environment variables).
3. Implement OIDC login (Authorization Code + PKCE) to obtain an access token.
4. On each API call, send `Authorization: Bearer <token>` and `X-Sandbox-Key`.
5. Handle the response statuses in section 5.
6. Run your app on port 3000 (or 5173) so Keycloak redirects and CORS succeed.
