# Requirements Document

## Introduction

This document defines the requirements for a customer-facing digital banking web application. The application is a Next.js (App Router, TypeScript) client of an existing, independently deployed banking sandbox. The application does not implement any banking business logic itself; it consumes the sandbox's HTTP APIs through a server-side Backend-for-Frontend (BFF) layer.

The contract between this application and the sandbox is the HTTP API only. No code is shared between the two systems. The sandbox exposes an API gateway secured by Keycloak OIDC authentication, and every request additionally requires a sandbox API key header. To keep credentials out of the browser, all outbound calls to the sandbox are made from Next.js server-side route handlers, so the browser never receives the access token or the API key.

The application provides authenticated customers with a dashboard of their accounts, an account statement view with an optional date-range filter, and a money-transfer form that maps each distinct sandbox transfer outcome to a clear UI state. The repository also includes standard project setup artifacts (`.gitignore`, `README`, environment example file, and a CI pipeline) so the project can be built, linted, type-checked, and run independently.

## Glossary

- **Banking_App**: The Next.js customer digital banking web application defined by this document.
- **BFF_Layer**: The Backend-for-Frontend; Next.js server-side route handlers that proxy requests from the browser to the Sandbox_Gateway, attaching the access token and API key server-side.
- **Browser_Client**: The client-side portion of the Banking_App running in the user's web browser.
- **Sandbox_Gateway**: The external banking sandbox API gateway, reachable at a configurable base URL (default `http://localhost:8081/api/v1`).
- **Identity_Provider**: The Keycloak server acting as the OIDC provider, with issuer `http://localhost:8080/realms/digital-bank` and public client `sandbox-web` using Authorization Code flow with PKCE.
- **Auth_Module**: The component of the Banking_App that manages OIDC authentication, session creation, and logout (for example, NextAuth configured with a Keycloak/OIDC provider).
- **Access_Token**: The OIDC bearer token issued by the Identity_Provider, sent to the Sandbox_Gateway in the `Authorization: Bearer <token>` header.
- **Sandbox_Key**: The static API key value sent to the Sandbox_Gateway in the `X-Sandbox-Key` header (default `demo-key-123`).
- **Customer**: An authenticated end user of the Banking_App (for example, test users `alice` or `bob`).
- **Account**: A bank account belonging to a Customer, identified by an account number.
- **Transaction**: A single movement of funds recorded against an Account.
- **Transfer**: A money movement request submitted via the Sandbox_Gateway transfer endpoint.
- **Dashboard**: The Banking_App view listing the signed-in Customer's accounts and balances.
- **Statement_View**: The Banking_App view showing a single Account's details and its transactions, with an optional date-range filter.
- **Transfer_Form**: The Banking_App form used to submit a Transfer.
- **Environment_Config**: The set of environment variables read from `.env.local` that configure the Sandbox_Gateway base URL, Identity_Provider settings, Sandbox_Key, and session secrets.
- **CI_Pipeline**: The GitHub Actions workflow that installs dependencies, lints, type-checks, and builds the Banking_App.
- **Error_Body**: The consistent JSON error payload returned by the Sandbox_Gateway on failures, containing `timestamp`, `status`, `error` (a machine-readable code such as `INSUFFICIENT_FUNDS`), `message`, and `path`.
- **Rate_Limit**: The Sandbox_Gateway per-API-key request limit (default 60 requests per minute); exceeding it yields HTTP 429.

## Requirements

### Requirement 1: OIDC Authentication

**User Story:** As a Customer, I want to log in and log out using the bank's identity provider, so that only I can access my banking data.

#### Acceptance Criteria

1. WHEN an unauthenticated Customer initiates login, THE Auth_Module SHALL start an OIDC Authorization Code flow with PKCE against the Identity_Provider using the `sandbox-web` client.
2. IF the Customer does not complete the OIDC authorization within 300 seconds of initiating login, THEN THE Auth_Module SHALL abort the flow, return the Customer to an unauthenticated state, and display an error message indicating the login attempt timed out.
3. WHEN the Identity_Provider returns a successful authorization response, THE Auth_Module SHALL exchange the authorization code for an Access_Token and establish an authenticated session.
4. IF OIDC authentication fails, is cancelled, or the authorization code exchange does not return a valid Access_Token, THEN THE Auth_Module SHALL return the Customer to an unauthenticated state without establishing a session, discard any partial credentials, and display an error message indicating that login did not succeed.
5. WHEN an authenticated Customer initiates logout, THE Auth_Module SHALL clear the local session, invalidate the Customer's Access_Token for the Banking_App, and redirect the Customer to the login entry point.
6. WHILE a Customer has no authenticated session, THE Banking_App SHALL redirect any request for a protected view to the login entry point without exposing protected data.
7. WHEN 24 hours have elapsed since the authenticated session was established, THE Auth_Module SHALL expire the session and treat subsequent requests from the Customer as unauthenticated.

### Requirement 2: Account Dashboard

**User Story:** As a Customer, I want to see a dashboard of my accounts and balances, so that I can review my finances at a glance.

#### Acceptance Criteria

1. WHEN an authenticated Customer opens the Dashboard, THE Banking_App SHALL request the Customer profile from the Sandbox_Gateway endpoint `GET /customers/me` through the BFF_Layer.
2. WHEN an authenticated Customer opens the Dashboard, THE Banking_App SHALL request the Customer's accounts from the Sandbox_Gateway endpoint `GET /accounts` through the BFF_Layer.
3. WHEN the account and profile data are returned successfully, THE Dashboard SHALL display the Customer identity and a list of Accounts, showing each Account's number and its balance formatted as a currency value.
4. WHILE the Dashboard data requests are in progress, THE Dashboard SHALL display a loading state for the affected regions.
5. IF the `GET /accounts` request returns an empty list, THEN THE Dashboard SHALL display an empty state indicating no accounts are available.
6. IF either Dashboard data request does not complete within 10 seconds, THEN THE Dashboard SHALL display an error state with a retry action for the affected region.
7. IF one of the two Dashboard data requests succeeds and the other fails, THEN THE Dashboard SHALL display the successful data and display an error state with a retry action only for the failed region.
8. IF the Sandbox_Gateway is unreachable or returns an error for the Dashboard data, THEN THE Dashboard SHALL display an error state with a retry action and SHALL continue running without crashing.
9. WHERE a Transfer has just completed, THE Dashboard MAY display Account balances that do not yet reflect that Transfer, because the sandbox account data is not synchronized with the payment ledger in v1.

### Requirement 3: Account Statement View

**User Story:** As a Customer, I want to view an account's details and transactions filtered by date, so that I can review activity for a specific period.

#### Acceptance Criteria

1. WHEN a Customer selects an Account, THE Banking_App SHALL request Account details from the Sandbox_Gateway endpoint `GET /accounts/{accountNumber}` through the BFF_Layer.
2. WHEN a Customer opens the Statement_View for an Account, THE Banking_App SHALL request Transactions from the Sandbox_Gateway endpoint `GET /transactions/accounts/{accountNumber}` through the BFF_Layer.
3. WHERE the Customer supplies a valid date range in which `from` is less than or equal to `to`, THE Banking_App SHALL include the supplied `from` and `to` values as ISO 8601 datetime query parameters on the Transactions request.
4. IF the Customer supplies a date range in which `from` is later than `to`, THEN THE Statement_View SHALL display a validation error, SHALL NOT send the Transactions request, and SHALL retain any previously loaded Transactions.
5. WHEN Transactions are returned successfully within 10 seconds, THE Statement_View SHALL display the Account details and the list of Transactions.
6. WHILE Transaction data is being loaded, THE Statement_View SHALL display a loading state within 500 milliseconds until the data resolves or fails.
7. IF the Transactions response contains zero Transactions for the selected range, THEN THE Statement_View SHALL display an empty state for that range.
8. IF the Sandbox_Gateway does not respond within 10 seconds or returns an error for the Statement_View data, THEN THE Statement_View SHALL display an error state with a retry action and SHALL continue running without crashing.

### Requirement 4: Money Transfer

**User Story:** As a Customer, I want to transfer money between accounts and understand the result, so that I know whether my payment succeeded, was held, or was rejected.

#### Acceptance Criteria

1. WHEN a Customer submits a Transfer_Form that passes all validation in Requirement 5, THE Banking_App SHALL send a `POST /payments/transfers` request to the Sandbox_Gateway through the BFF_Layer with a JSON body containing `fromAccount`, `toAccount`, `amount`, and `description`.
2. WHILE a Transfer request is in progress, THE Transfer_Form SHALL disable the submit control to prevent duplicate submission.
3. WHEN the Sandbox_Gateway responds with HTTP 201, THE Transfer_Form SHALL display a completed-transfer success state that is distinct from all other outcome states.
4. WHEN the Sandbox_Gateway responds with HTTP 202, THE Transfer_Form SHALL display a distinct state indicating the Transfer is held for anti-money-laundering review.
5. IF the Sandbox_Gateway responds with HTTP 422, THEN THE Transfer_Form SHALL display a distinct state indicating the Transfer was blocked by anti-money-laundering controls.
6. IF the Sandbox_Gateway responds with HTTP 409 (a business conflict such as insufficient funds, same source and destination account, currency mismatch, or invalid amount), THEN THE Transfer_Form SHALL display a distinct error state whose message reflects the `error` code from the Error_Body.
7. IF the Sandbox_Gateway responds with HTTP 403, THEN THE Transfer_Form SHALL display a distinct state indicating the Customer is not the owner of the source Account.
8. IF the Sandbox_Gateway responds with HTTP 401, THEN THE Banking_App SHALL treat the Customer as unauthenticated and route the Customer to re-authentication.
9. IF the Sandbox_Gateway responds with HTTP 429, THEN THE Transfer_Form SHALL display a distinct state indicating the request was rate-limited and SHALL allow the Customer to retry after a short delay.
10. IF the Sandbox_Gateway is unreachable, does not respond within 30 seconds, or returns any status not covered by criteria 3 through 9, THEN THE Transfer_Form SHALL display a generic error state with a retry action, SHALL retain the entered form values, and SHALL continue running without crashing.

### Requirement 5: Transfer Form Validation

**User Story:** As a Customer, I want the transfer form to validate my input, so that I avoid submitting invalid payments.

#### Acceptance Criteria

1. IF the `fromAccount` field is empty when the Transfer_Form is submitted, THEN THE Transfer_Form SHALL display a validation error message indicating that a source account is required and SHALL NOT send the request.
2. IF the `toAccount` field is empty when the Transfer_Form is submitted, THEN THE Transfer_Form SHALL display a validation error message indicating that a destination account is required and SHALL NOT send the request.
3. IF the `fromAccount` value is equal to the `toAccount` value when the Transfer_Form is submitted, THEN THE Transfer_Form SHALL display a validation error message indicating that the source and destination accounts must differ and SHALL NOT send the request.
4. IF the `amount` value is empty, less than or equal to 0, greater than 999,999,999.99, or contains more than two decimal places when the Transfer_Form is submitted, THEN THE Transfer_Form SHALL display a validation error message indicating that the amount must be a positive number between 0.01 and 999,999,999.99 with at most two decimal places and SHALL NOT send the request.
5. WHERE a `description` of 0 to 140 characters is provided, THE Transfer_Form SHALL accept the description.
6. IF the provided `description` exceeds 140 characters when the Transfer_Form is submitted, THEN THE Transfer_Form SHALL display a validation error message indicating that the description exceeds the maximum length and SHALL NOT send the request.

### Requirement 6: Server-Side Credential Handling (BFF)

**User Story:** As a security-conscious Customer, I want my access token and the sandbox API key kept out of my browser, so that my credentials are not exposed to client-side code.

#### Acceptance Criteria

1. WHEN the Browser_Client requests Sandbox_Gateway data through the BFF_Layer, THE BFF_Layer SHALL attach the `Authorization: Bearer <access_token>` header and the `X-Sandbox-Key` header to the outbound Sandbox_Gateway request server-side, and SHALL complete the request within 10 seconds.
2. THE Banking_App SHALL keep the Access_Token within server-side code, and SHALL NOT include the Access_Token in any response headers, response body, cookies, or other payload returned to the Browser_Client.
3. THE Banking_App SHALL keep the Sandbox_Key within server-side code, and SHALL NOT include the Sandbox_Key in any response headers, response body, cookies, or other payload returned to the Browser_Client.
4. WHEN the Browser_Client needs Sandbox_Gateway data, THE Browser_Client SHALL request that data through the BFF_Layer rather than calling the Sandbox_Gateway directly.
5. IF the Access_Token or the Sandbox_Key is not available within server-side code when a Sandbox_Gateway request is required, THEN THE BFF_Layer SHALL NOT send the outbound request to the Sandbox_Gateway and SHALL return a response to the Browser_Client indicating the request could not be authenticated, without exposing the Access_Token or the Sandbox_Key.
6. IF the Sandbox_Gateway request fails or does not complete within 10 seconds, THEN THE BFF_Layer SHALL return a response to the Browser_Client indicating the upstream request failed, and SHALL NOT include the Access_Token or the Sandbox_Key in that response.
7. WHEN the Sandbox_Gateway returns an Error_Body, THE BFF_Layer SHALL forward the `status` and `error` code to the Browser_Client so the UI can present an outcome-specific message, WITHOUT exposing the Access_Token or the Sandbox_Key.

### Requirement 7: Environment-Driven Configuration

**User Story:** As an operator, I want all endpoints and secrets supplied through environment variables, so that the same build can target a local or hosted sandbox without code changes.

#### Acceptance Criteria

1. WHEN the Banking_App starts, THE Banking_App SHALL read the Sandbox_Gateway base URL from Environment_Config, and WHERE no value is configured for local use, THE Banking_App SHALL default it to `http://localhost:8081/api/v1`.
2. WHEN the Banking_App starts, THE Banking_App SHALL read the Identity_Provider issuer and the Identity_Provider client identifier from Environment_Config.
3. WHEN the Banking_App starts, THE Banking_App SHALL read the Sandbox_Key from Environment_Config.
4. WHEN the Banking_App starts, THE Banking_App SHALL read the Auth_Module session secret and the application URL from Environment_Config.
5. THE Banking_App SHALL NOT contain literal Sandbox_Gateway URLs, Identity_Provider URLs, or Sandbox_Key values anywhere in application source code.
6. IF a required Environment_Config value among those in criteria 1 through 4 is missing or is an empty string when the Banking_App starts, THEN THE Banking_App SHALL abort startup without serving requests and SHALL report a configuration error naming each missing value.
7. IF a configured Sandbox_Gateway URL, Identity_Provider issuer URL, or application URL is not a well-formed URL when the Banking_App starts, THEN THE Banking_App SHALL abort startup without serving requests and SHALL report a configuration error naming the malformed value.

### Requirement 8: Resilience and Graceful Degradation

**User Story:** As a Customer, I want the app to stay usable when the sandbox is slow or unavailable, so that I am never left with a broken screen.

#### Acceptance Criteria

1. WHILE a Sandbox_Gateway request is in progress, THE Banking_App SHALL display a loading state for the affected view within 300 milliseconds of initiating the request.
2. IF a Sandbox_Gateway request fails due to a network or connectivity error, THEN THE Banking_App SHALL display an error message indicating a connectivity problem and SHALL display a retry action that re-initiates the failed request.
3. IF a Sandbox_Gateway request does not complete within 15 seconds, THEN THE Banking_App SHALL cancel the request, display an error message indicating a timeout, and display a retry action that re-initiates the request.
4. IF a Sandbox_Gateway request returns an error status, THEN THE Banking_App SHALL display an error message appropriate to the affected view, SHALL retain any previously loaded data for that view, and SHALL keep navigation to all other views available.
5. WHEN a Sandbox_Gateway request returns a successful response containing no data for the affected view, THE Banking_App SHALL display an empty state for that view.
6. THE Banking_App SHALL provide a distinct loading state, empty state, and error state for each view that depends on Sandbox_Gateway data.
7. IF the Sandbox_Gateway responds with HTTP 429 for any view, THEN THE Banking_App SHALL display a rate-limit message and SHALL NOT retry automatically before a delay.

### Requirement 9: Repository Setup and Continuous Integration

**User Story:** As a developer, I want standard project setup and a CI pipeline, so that I can run and verify the app independently of the sandbox repository.

#### Acceptance Criteria

1. THE Banking_App repository SHALL include a `.gitignore` that excludes at minimum `node_modules`, build output, and local environment files such as `.env.local`.
2. THE Banking_App repository SHALL include a `README` documenting the required Node.js version, a step-ordered instruction to start the sandbox before the Banking_App, and how to run the application on port 3000.
3. THE Banking_App repository SHALL include a `.env.local.example` file documenting every required Environment_Config variable with placeholder values, including the Sandbox_Gateway base URL, Identity_Provider issuer and client, Sandbox_Key, session secret, and application URL.
4. THE Banking_App repository SHALL include a GitHub Actions CI_Pipeline that runs, in order, dependency installation, linting, type-checking, and an application build as distinct steps.
5. IF any CI_Pipeline step fails, THEN THE CI_Pipeline SHALL stop and report the pipeline as failed.
6. THE CI_Pipeline SHALL run to completion using only this repository's sources and SHALL NOT depend on the sandbox repository.

### Requirement 10: Local Runtime Environment

**User Story:** As a developer, I want the app to run on a known port with the configured CORS and redirect settings, so that authentication and API calls work against the sandbox out of the box.

#### Acceptance Criteria

1. WHEN the Banking_App is started in local development, THE Banking_App SHALL bind to TCP port 3000.
2. IF TCP port 3000 is already in use when the Banking_App is started, THEN THE Banking_App SHALL terminate startup within 10 seconds and emit an error message indicating that port 3000 is unavailable.
3. WHEN the Auth_Module performs OIDC redirects, THE Auth_Module SHALL use a redirect URI with scheme `http`, host `localhost`, and port 3000 that is registered on the Identity_Provider `sandbox-web` client.
4. IF the OIDC redirect URI presented by the Auth_Module is not registered on the Identity_Provider `sandbox-web` client, THEN THE Auth_Module SHALL abort the authentication flow and emit an error message indicating that the redirect URI is not authorized.
5. WHEN the BFF_Layer issues a request to the Sandbox_Gateway, THE BFF_Layer SHALL send it from origin `http://localhost:3000`, which is included in the Sandbox_Gateway CORS allowed-origins list.
6. IF the Sandbox_Gateway rejects a BFF_Layer request with a CORS origin-denied response, THEN THE BFF_Layer SHALL fail the request and emit an error message indicating that the request origin is not permitted.

### Requirement 11: Testability with Mocked Sandbox Responses

**User Story:** As a developer, I want unit and integration tests backed by mocked sandbox responses, so that each outcome and failure mode is verifiable without the live sandbox.

#### Acceptance Criteria

1. THE Banking_App SHALL support unit and integration tests that execute to a pass or fail result using mocked Sandbox_Gateway responses and without issuing any network request to the live Sandbox_Gateway.
2. WHERE a Transfer outcome status is 201, 202, 422, 409, 403, or 401, THE Banking_App SHALL provide a test that supplies the corresponding mocked response and asserts a distinct, observable Transfer_Form state for that status.
3. WHEN a Sandbox_Gateway request is pending, resolves with an empty result set, or resolves as a failure, THE Banking_App SHALL provide tests that assert the corresponding loading, empty, and error states for each Sandbox_Gateway-dependent view, where the error state includes an observable error indication visible to the user.
4. THE Banking_App SHALL provide tests that verify Transfer_Form validation rejects submission with an observable field-level error when a required field is empty, when the source and destination accounts are equal, when the amount is not within 0.01 to 999,999,999.99 or is non-numeric, or when the description exceeds 140 characters.
