# Requirements Document

## Introduction

This document defines the requirements for the **client-side realism features** of the customer-facing digital banking web application (the Banking_App). It is a second, sibling specification to the existing `customer-banking-app` spec, which built the v1 application. The v1 spec remains authoritative for everything it already covers (OIDC authentication, the core Dashboard, Statement_View, Transfer_Form, the BFF_Layer, configuration, resilience, repository setup, and the existing test suite); this spec extends that foundation and does not restate or modify v1 requirements except where explicitly stated below.

The Banking_App remains a **pure HTTP client** of the independently deployed RP Digital Bank Sandbox. It implements no banking business logic and holds no ledger state. Every piece of banking data originates from the Sandbox_Gateway and is only presented by this application. The architectural contract from v1 is preserved without exception: the Browser_Client never possesses the Access_Token or the Sandbox_Key, and every outbound call to the Sandbox_Gateway is made from server-side Next.js route handlers (the BFF_Layer, via the shared server-side `sandboxClient` helper). Any new data need introduced by this spec MUST be served by a new same-origin `/api/bff/*` route; the Browser_Client MUST NOT call the Sandbox_Gateway directly. This invariant continues to be guarded by the existing property test (Feature: customer-banking-app, Property 5).

This spec also preserves the v1 client patterns for every new data-dependent view: the per-region loading/empty/error state machine with a retry action; routing to re-authentication once on HTTP 401; a rate-limit message with no automatic retry on HTTP 429; the shared `LoadingState`, `EmptyState`, and `ErrorState` components; the `TransferResultBanner` for transfer outcomes; and a pure, shared client-side validation module (`transferValidation.ts`) kept in sync with server-side BFF validation.

### Superseding note on balance freshness (supersedes customer-banking-app Requirement 2.9)

The v1 spec's Requirement 2.9 permitted the Dashboard to display stale Account balances because, in v1, the sandbox account service was not synchronized with the payment ledger. A companion **backend** specification (maintained in a separate repository) now propagates completed Transfers to the account service — via a transactional outbox and scheduled consumers — so that Account balances and Statement history **do** update to reflect completed Transfers, subject to a short propagation delay.

This spec **supersedes the v1 Requirement 2.9 caveat**: Account balances and Statement history are now expected to reflect completed Transfers after a brief propagation delay, rather than being tolerated as permanently stale. The Banking_App provides a manual refresh affordance so a Customer can re-fetch current data once propagation has occurred.

The backend propagation mechanism (outbox, consumers, ledger-to-account synchronization) is **out of scope for this client spec**. This spec only consumes the corrected sandbox data and presents it; it does not implement, trigger, or verify the propagation itself. The Banking_App therefore treats the propagation delay as an external timing characteristic and provides manual refresh rather than guaranteeing a specific freshness window.

## Glossary

This spec reuses the v1 Glossary terms unchanged. The terms most relevant here are repeated for convenience, followed by terms introduced by this spec.

### Reused from customer-banking-app

- **Banking_App**: The Next.js customer digital banking web application.
- **BFF_Layer**: The Backend-for-Frontend; Next.js server-side route handlers that proxy requests from the browser to the Sandbox_Gateway, attaching the Access_Token and Sandbox_Key server-side.
- **Browser_Client**: The client-side portion of the Banking_App running in the user's web browser.
- **Sandbox_Gateway**: The external banking sandbox API gateway, reachable at a configurable base URL (default `http://localhost:8081/api/v1`).
- **Access_Token**: The OIDC bearer token sent to the Sandbox_Gateway in the `Authorization: Bearer <token>` header; confined to server-side code.
- **Sandbox_Key**: The static API key sent to the Sandbox_Gateway in the `X-Sandbox-Key` header; confined to server-side code.
- **Customer**: An authenticated end user of the Banking_App (for example, test users `alice` or `bob`).
- **CustomerProfile**: The Customer profile object returned by the Sandbox_Gateway endpoint `GET /customers/me` and exposed to the Browser_Client via `GET /api/bff/customer`.
- **Account**: A bank account belonging to a Customer, identified by an account number, with a type, status, currency, and balance.
- **Transaction**: A single movement of funds recorded against an Account, with a direction (CREDIT or DEBIT), amount, timestamp, description, and optional counterparty and running balance.
- **Transfer**: A money movement request submitted via the Sandbox_Gateway transfer endpoint.
- **Dashboard**: The Banking_App view listing the signed-in Customer's accounts and balances.
- **Statement_View**: The Banking_App view showing a single Account's details and its Transactions, with an optional date-range filter.
- **Transfer_Form**: The Banking_App form used to submit a Transfer.
- **TransferResultBanner**: The shared Browser_Client component that renders a distinct UI state for each Transfer outcome.
- **LoadingState / EmptyState / ErrorState**: The shared Browser_Client components that render, respectively, the loading, empty, and error states for a data-dependent view region.
- **Environment_Config**: The set of environment variables that configure the Sandbox_Gateway base URL, Identity_Provider settings, Sandbox_Key, and session secrets.
- **Error_Body**: The consistent JSON error payload returned by the Sandbox_Gateway on failures, containing `timestamp`, `status`, `error` (a machine-readable code), `message`, and `path`.
- **Rate_Limit**: The Sandbox_Gateway per-API-key request limit (default 60 requests per minute); exceeding it yields HTTP 429.

### Introduced by this spec

- **Account_Details_View**: The dedicated, read-only Banking_App view showing a single Account's type, status, currency, and balance.
- **Account_Management**: The Banking_App capability to open a new Account and to close (deactivate) an existing Account, each via a new BFF route backed by a Sandbox_Gateway endpoint.
- **Account_Status**: The lifecycle state of an Account as reported by the Sandbox_Gateway (for example, `ACTIVE` or `CLOSED`).
- **Saved_Payee**: A Customer-defined, backend-persisted record pairing a human-readable label with a destination account, used to pre-fill the Transfer_Form "To account" field.
- **Payee_Picker**: The Browser_Client control on the Transfer_Form that lists the Customer's Saved_Payees and populates the "To account" field when one is selected.
- **Scheduled_Transfer**: A Transfer configured for future-dated or recurring execution, persisted and executed by the backend sandbox through the existing payment path.
- **Scheduled_Transfer_Status**: The lifecycle state of a Scheduled_Transfer as reported by the Sandbox_Gateway (for example, `SCHEDULED`, `EXECUTED`, `FAILED`, or `CANCELLED`).
- **Profile_Page**: The Banking_App view at route `/profile` that renders the CustomerProfile data.
- **AppHeader**: The shared Browser_Client navigation component providing application navigation and a logout control, used by every authenticated Banking_App page.
- **Currency_Formatter**: The shared Browser_Client utility that formats a numeric amount and a currency code into a displayed currency value.
- **Manual_Refresh**: A Browser_Client control on a data-dependent view that re-initiates the view's data request(s) on demand without a full page reload.
- **transferValidation**: The pure, shared client-side validation module whose rules are kept in sync with the server-side BFF validation.

## Requirements

### Requirement 1: Correct Balance and Statement Freshness

**User Story:** As a Customer, I want my Dashboard balances and statement history to reflect transfers I have just completed, so that I can trust the figures the app shows me.

#### Acceptance Criteria

1. WHEN an authenticated Customer opens the Dashboard, THE Dashboard SHALL display each Account's balance from the most recent successful `GET /accounts` response obtained through the BFF_Layer, with each balance formatted by the Currency_Formatter.
2. WHEN a Customer re-opens or re-fetches the Dashboard through the BFF_Layer, THE Dashboard SHALL display Account balances equal to the balances contained in that latest successful `GET /accounts` response, so that any completed Transfer already propagated by the backend to the account service is reflected without additional client-side adjustment.
3. WHEN a Customer re-opens or re-fetches the Statement_View for an Account through the BFF_Layer, THE Statement_View SHALL display exactly the Transaction entries contained in that latest successful Transactions response for the Account, so that any completed Transfer already propagated by the backend to the account service is reflected without additional client-side adjustment.
4. THE Dashboard SHALL provide a Manual_Refresh control that re-initiates the Dashboard data requests through the BFF_Layer without a full page reload.
5. THE Statement_View SHALL provide a Manual_Refresh control that re-initiates the Account details and Transactions requests through the BFF_Layer without a full page reload.
6. WHILE a Manual_Refresh request is in progress, THE affected view SHALL display a loading state for the affected region within 300 milliseconds of initiating the request and SHALL disable the Manual_Refresh control to prevent duplicate submission.
7. WHEN a Manual_Refresh request completes successfully, THE affected view SHALL replace the displayed data with the newly returned data and SHALL re-enable the Manual_Refresh control.
8. IF a Manual_Refresh request fails or does not complete within 10 seconds, THEN THE affected view SHALL display an error state with a retry action, SHALL retain the previously displayed data, SHALL re-enable the Manual_Refresh control, and SHALL continue running without crashing.

### Requirement 2: Account Details View

**User Story:** As a Customer, I want a dedicated account details screen, so that I can review a single account's type, status, currency, and balance clearly.

#### Acceptance Criteria

1. WHEN an authenticated Customer opens the Account_Details_View for an Account, THE Banking_App SHALL request Account details from the Sandbox_Gateway endpoint `GET /accounts/{accountNumber}` through the BFF_Layer.
2. WHEN the Account details are returned successfully within 10 seconds, THE Account_Details_View SHALL display, from the returned Account only, the Account number, the Account type, the Account_Status, the currency, and the balance, and SHALL format the balance using the Currency_Formatter with the returned currency.
3. WHILE the Account details request is in progress, THE Account_Details_View SHALL display a loading state for the affected region within 300 milliseconds of initiating the request.
4. IF the Account details request completes within 10 seconds with no Account for the requested account number, THEN THE Account_Details_View SHALL display an empty state indicating the Account is unavailable and SHALL NOT display any Account field values.
5. IF the Sandbox_Gateway does not respond within 10 seconds or returns an error status not covered by criteria 4, 6, 7, or 9 for the Account details request, THEN THE Account_Details_View SHALL cancel any in-progress request, display an error state with a retry action that re-initiates the request, and SHALL continue running without crashing.
6. IF the Sandbox_Gateway responds with HTTP 403 for the Account details request, THEN THE Account_Details_View SHALL display a distinct state indicating the Customer is not the owner of the Account.
7. IF the Sandbox_Gateway responds with HTTP 401 for the Account details request, THEN THE Banking_App SHALL treat the Customer as unauthenticated and route the Customer to re-authentication.
8. THE Account_Details_View SHALL render the Account details as read-only and SHALL NOT provide any control that modifies the Account within this view.
9. IF the Sandbox_Gateway responds with HTTP 429 for the Account details request, THEN THE Account_Details_View SHALL display a rate-limit message and SHALL NOT retry automatically before a delay of at least 60 seconds.

### Requirement 3: Account Management (Open and Close)

**User Story:** As a Customer, I want to open a new account and close an account I no longer need, so that I can manage my own account portfolio.

#### Acceptance Criteria

1. WHEN an authenticated Customer submits an open-account request that passes the criterion 2 validation rules, THE Banking_App SHALL send the request to the Sandbox_Gateway account-creation endpoint through a new `/api/bff/*` route in the BFF_Layer.
2. IF the open-account request is submitted with a missing Account type, an Account type outside the set accepted by the Sandbox_Gateway account-creation endpoint, or a missing currency, THEN THE Banking_App SHALL display a field-level validation error identifying each invalid field and SHALL NOT send the request.
3. WHEN the Sandbox_Gateway returns a success response to the open-account request within 10 seconds, THE Banking_App SHALL display a success outcome state and SHALL make the newly opened Account available to the Dashboard on its next data request.
4. WHEN an authenticated Customer initiates a close-account action for an Account, THE Banking_App SHALL require an explicit confirmation before sending any request to the BFF_Layer.
5. WHEN a Customer confirms the close-account action, THE Banking_App SHALL send the close request to the Sandbox_Gateway account-close endpoint through a new `/api/bff/*` route in the BFF_Layer.
6. WHEN the Sandbox_Gateway returns a success response to the close-account request within 10 seconds, THE Banking_App SHALL display a success outcome state and SHALL reflect the updated Account_Status on the next Dashboard or Account_Details_View data request.
7. IF the Customer cancels the close-account confirmation, THEN THE Banking_App SHALL NOT send any request to the BFF_Layer and SHALL leave the Account unchanged.
8. IF the Sandbox_Gateway responds with HTTP 403 for an open-account or close-account request, THEN THE Banking_App SHALL display a distinct state indicating the Customer is not authorized to manage the Account.
9. IF the Sandbox_Gateway responds with HTTP 409 for a close-account request (a business conflict such as a non-zero balance or an already-closed Account), THEN THE Banking_App SHALL display a distinct error state whose message reflects the `error` code from the Error_Body.
10. IF the Sandbox_Gateway responds with HTTP 401 for an open-account or close-account request, THEN THE Banking_App SHALL treat the Customer as unauthenticated and route the Customer to re-authentication.
11. IF the Sandbox_Gateway responds with HTTP 429 for an open-account or close-account request, THEN THE Banking_App SHALL display a rate-limit message and SHALL NOT retry automatically before a delay of at least 60 seconds.
12. IF the Sandbox_Gateway is unreachable, does not respond within 10 seconds, or returns any status not covered by criteria 3 through 11 for an Account_Management request, THEN THE Banking_App SHALL display a generic error state with a retry action and SHALL continue running without crashing.

### Requirement 4: Transaction History Improvements

**User Story:** As a Customer, I want transfer-driven entries to appear in my statement with clear direction and counterparty, so that I can understand each movement on my account.

#### Acceptance Criteria

1. WHEN the Statement_View displays Transactions from the most recent successful Transactions response for an Account, THE Statement_View SHALL display each Transaction's direction as a debit or a credit according to that Transaction's direction.
2. WHEN a Transaction has an associated counterparty, THE Statement_View SHALL display the counterparty for that Transaction; and WHERE a Transaction has no counterparty, THE Statement_View SHALL omit the counterparty for that Transaction without displaying an error.
3. WHERE a Transaction includes a running balance, THE Statement_View SHALL display the running balance alongside that Transaction.
4. WHEN a Customer re-fetches the Statement_View for the source Account of a completed Transfer that has propagated to the account service, THE Statement_View SHALL display a debit entry for that Transfer; and WHEN a Customer re-fetches the Statement_View for the destination Account, THE Statement_View SHALL display a credit entry for that Transfer.
5. THE Statement_View SHALL retain the existing optional date-range filter in which a valid range requires `from` to be less than or equal to `to`.
6. IF the Customer supplies a date range in which `from` is later than `to`, THEN THE Statement_View SHALL display a validation error, SHALL NOT send the Transactions request, and SHALL retain any previously loaded Transactions.
7. WHERE the Customer supplies a valid date range, THE Statement_View SHALL include the supplied `from` and `to` values as ISO 8601 datetime query parameters on the Transactions request through the BFF_Layer.
8. WHILE the Transactions request is in progress, THE Statement_View SHALL display a loading state for the affected region within 500 milliseconds of initiating the request.
9. IF the Transactions response contains zero Transactions for the selected range, THEN THE Statement_View SHALL display an empty state for that range.
10. IF the Sandbox_Gateway does not respond within 10 seconds or returns an error for the Transactions request, THEN THE Statement_View SHALL display an error state with a retry action, SHALL retain any previously loaded Transactions, and SHALL continue running without crashing.

### Requirement 5: Saved Payees

**User Story:** As a Customer, I want to save and reuse payees, so that I can start a transfer without retyping a destination account.

#### Acceptance Criteria

1. WHEN an authenticated Customer submits a create-payee request that passes the criterion 2 validation rules, THE Banking_App SHALL send the request to the Sandbox_Gateway saved-payee endpoint through a new `/api/bff/*` route in the BFF_Layer.
2. IF a create-payee request is submitted with an empty label or an empty destination account, THEN THE Banking_App SHALL display a field-level validation error identifying each invalid field and SHALL NOT send the request.
3. WHEN the Sandbox_Gateway returns a success response to a create-payee request, THE Banking_App SHALL display a success outcome state and SHALL make the newly created Saved_Payee available to the Payee_Picker on its next data request.
4. WHEN an authenticated Customer opens the Payee_Picker, THE Banking_App SHALL request the Customer's Saved_Payees from the Sandbox_Gateway through the BFF_Layer.
5. WHEN the Saved_Payees are returned successfully, THE Payee_Picker SHALL display each Saved_Payee's label and destination account.
6. WHEN a Customer selects a Saved_Payee in the Payee_Picker, THE Transfer_Form SHALL populate the "To account" field with that Saved_Payee's destination account.
7. WHEN a Customer requests deletion of a Saved_Payee and the Sandbox_Gateway returns a success response, THE Banking_App SHALL remove that Saved_Payee from the Payee_Picker.
8. IF the Saved_Payees request returns an empty list, THEN THE Payee_Picker SHALL display an empty state indicating no saved payees are available.
9. WHILE a Saved_Payees request is in progress, THE Payee_Picker SHALL display a loading state for the affected region within 300 milliseconds of initiating the request.
10. IF the Sandbox_Gateway does not respond within 10 seconds or returns an error for a Saved_Payee request, THEN THE Banking_App SHALL display an error state with a retry action, SHALL retain any previously entered create-payee values, and SHALL continue running without crashing.
11. IF the Sandbox_Gateway responds with HTTP 401 for a Saved_Payee request, THEN THE Banking_App SHALL treat the Customer as unauthenticated and route the Customer to re-authentication.
12. IF the Sandbox_Gateway responds with HTTP 429 for a Saved_Payee request, THEN THE Banking_App SHALL display a rate-limit message and SHALL NOT retry automatically before a delay of at least 60 seconds.
13. THE transferValidation module SHALL apply the same label and destination-account validation rules on the client as the BFF_Layer applies server-side for Saved_Payee creation.

### Requirement 6: Scheduled and Recurring Transfers

**User Story:** As a Customer, I want to schedule a future or recurring transfer and manage it, so that I can automate payments without logging in each time.

#### Acceptance Criteria

1. WHEN an authenticated Customer submits a Scheduled_Transfer request that passes the criteria 2 and 3 validation rules, THE Banking_App SHALL send the request to the Sandbox_Gateway scheduled-transfer endpoint through a new `/api/bff/*` route in the BFF_Layer with the source account, destination account, amount, description, schedule date as an ISO 8601 date, and a recurrence selected from the supported recurrence set (including a one-off option).
2. THE Banking_App SHALL apply the transferValidation rules for source account, destination account, amount, and description to a Scheduled_Transfer request before sending it, consistent with the existing Transfer_Form validation.
3. IF a Scheduled_Transfer request specifies a schedule date that is not strictly after the current date, THEN THE Banking_App SHALL display a field-level validation error and SHALL NOT send the request.
4. WHEN the Sandbox_Gateway returns a success response to a Scheduled_Transfer creation request within 10 seconds, THE Banking_App SHALL display a success outcome state and SHALL make the Scheduled_Transfer available to the scheduled-transfer list on its next data request.
5. WHEN an authenticated Customer opens the scheduled-transfer list, THE Banking_App SHALL request the Customer's Scheduled_Transfers from the Sandbox_Gateway through the BFF_Layer and SHALL display each Scheduled_Transfer with its Scheduled_Transfer_Status.
6. WHEN a Customer requests cancellation of a Scheduled_Transfer whose Scheduled_Transfer_Status is SCHEDULED and the Sandbox_Gateway returns a success response, THE Banking_App SHALL display that Scheduled_Transfer with a cancelled status.
7. WHEN a Scheduled_Transfer has executed through the backend payment path, THE Banking_App SHALL display the resulting outcome using the same outcome mapping as the Transfer_Form, including the held-for-review and blocked outcomes produced by anti-money-laundering controls.
8. IF the scheduled-transfer list request returns an empty list, THEN THE Banking_App SHALL display an empty state indicating no scheduled transfers are available.
9. WHILE a scheduled-transfer list request is in progress, THE Banking_App SHALL display a loading state for the affected region within 300 milliseconds of initiating the request.
10. IF the Sandbox_Gateway does not respond within 10 seconds or returns an error for a Scheduled_Transfer request, THEN THE Banking_App SHALL display an error state with a retry action and SHALL continue running without crashing.
11. IF the Sandbox_Gateway responds with HTTP 401 for a Scheduled_Transfer request, THEN THE Banking_App SHALL treat the Customer as unauthenticated and route the Customer to re-authentication.
12. IF the Sandbox_Gateway responds with HTTP 409 for a Scheduled_Transfer cancellation request (for example, the Scheduled_Transfer has already executed or already been cancelled), THEN THE Banking_App SHALL display a distinct error state whose message reflects the `error` code from the Error_Body.
13. IF the Sandbox_Gateway responds with HTTP 429 for a Scheduled_Transfer request, THEN THE Banking_App SHALL display a rate-limit message and SHALL NOT retry automatically before a delay of at least 60 seconds.

### Requirement 7: Profile and Settings Page

**User Story:** As a Customer, I want a profile page showing my details, so that I can review and, where supported, update my information.

#### Acceptance Criteria

1. WHEN an authenticated Customer opens the Profile_Page at route `/profile`, THE Banking_App SHALL request the CustomerProfile from the existing `GET /api/bff/customer` route in the BFF_Layer.
2. WHEN the CustomerProfile is returned successfully within 10 seconds, THE Profile_Page SHALL display the CustomerProfile fields returned by the BFF_Layer.
3. WHILE the CustomerProfile request is in progress, THE Profile_Page SHALL display a loading state for the affected region within 300 milliseconds of initiating the request.
4. IF the CustomerProfile request returns no CustomerProfile, THEN THE Profile_Page SHALL display an empty state indicating the profile is unavailable.
5. IF the Sandbox_Gateway does not respond within 10 seconds or returns an error for the CustomerProfile request, THEN THE Profile_Page SHALL display an error state with a retry action and SHALL continue running without crashing.
6. IF the Sandbox_Gateway responds with HTTP 401 for the CustomerProfile request, THEN THE Banking_App SHALL treat the Customer as unauthenticated and route the Customer to re-authentication.
7. IF the Sandbox_Gateway responds with HTTP 429 for the CustomerProfile request, THEN THE Banking_App SHALL display a rate-limit message and SHALL NOT retry automatically before a delay of at least 60 seconds.
8. WHERE the Sandbox_Gateway supports CustomerProfile edits, THE Banking_App SHALL submit an update through a new profile-update `/api/bff/*` route in the BFF_Layer backed by the corresponding Sandbox_Gateway update endpoint.
9. WHERE the Sandbox_Gateway supports CustomerProfile edits, THE Banking_App SHALL validate each editable field on the client before sending the update and SHALL display a field-level validation error for any invalid field without sending the request.
10. WHERE the Sandbox_Gateway does not support CustomerProfile edits, THE Profile_Page SHALL render the CustomerProfile as read-only and SHALL NOT present an edit control.
11. WHEN a supported CustomerProfile update is confirmed by the Sandbox_Gateway, THE Profile_Page SHALL display a success outcome state and SHALL display the updated CustomerProfile fields.
12. WHERE the Sandbox_Gateway supports CustomerProfile edits, IF the Sandbox_Gateway does not respond within 10 seconds or returns an error rejecting the CustomerProfile update, THEN THE Profile_Page SHALL display an error state indicating the update was not applied, SHALL retain the previously displayed CustomerProfile fields, and SHALL continue running without crashing.
13. WHERE the Sandbox_Gateway supports CustomerProfile edits, IF the Sandbox_Gateway responds with HTTP 401 for a CustomerProfile update request, THEN THE Banking_App SHALL treat the Customer as unauthenticated and route the Customer to re-authentication.

### Requirement 8: Shared Navigation and Currency Formatting

**User Story:** As a Customer, I want consistent navigation and consistently formatted amounts across the app, so that every screen feels like one coherent product.

#### Acceptance Criteria

1. THE Banking_App SHALL provide a shared AppHeader component that renders a navigation control to each of the Dashboard, Statement_View, Account_Details_View, Transfer_Form, Profile_Page, every Account_Management view, and every Scheduled_Transfer view, together with a single logout control.
2. WHILE a Customer is authenticated, THE Banking_App SHALL render the shared AppHeader on the Dashboard, Statement_View, Account_Details_View, Transfer_Form, Profile_Page, and every Account_Management and Scheduled_Transfer view.
3. WHEN a Customer activates the logout control in the AppHeader, THE Banking_App SHALL invoke the existing logout flow that clears the local session and redirects the Customer to the login entry point.
4. THE Banking_App SHALL provide a shared Currency_Formatter utility that formats a numeric amount together with a currency code into a displayed currency value.
5. THE Banking_App SHALL format every displayed Account balance and every displayed monetary amount using the Currency_Formatter.
6. WHEN the Currency_Formatter formats the same numeric amount with the same currency code, THE Currency_Formatter SHALL produce output that is character-for-character identical across every view and every invocation, independent of the time of rendering and of the Browser_Client host locale settings.
7. IF the Currency_Formatter is given an amount that is null, undefined, or not a finite number, THEN THE Currency_Formatter SHALL return a fixed placeholder display value rather than a formatted amount and SHALL NOT throw.
8. IF the Currency_Formatter is given a currency code that is empty or not a supported ISO 4217 three-letter code, THEN THE Currency_Formatter SHALL render the numeric amount with the provided code shown verbatim as the currency indicator and SHALL NOT throw.
9. WHEN the Browser_Client requires Sandbox_Gateway data for any view introduced by this spec, THE Browser_Client SHALL request that data from a same-origin `/api/bff/*` route and SHALL NOT call the Sandbox_Gateway directly.

### Requirement 9: Server-Side Credential Handling for New BFF Routes

**User Story:** As a security-conscious Customer, I want the new account, payee, scheduled-transfer, and profile features to keep my credentials off the browser, so that adding features does not weaken the app's security posture.

#### Acceptance Criteria

1. WHEN the Browser_Client requests data through any new `/api/bff/*` route introduced by this spec for Account_Management, Saved_Payee, Scheduled_Transfer, or CustomerProfile, THE BFF_Layer SHALL attach the `Authorization: Bearer <access_token>` header and the `X-Sandbox-Key` header to the outbound Sandbox_Gateway request server-side.
2. THE BFF_Layer SHALL keep the Access_Token and the Sandbox_Key within server-side code for every new route, and SHALL NOT include the value of either in any response status line, response header, response body, cookie, or other payload returned to the Browser_Client, for both successful and error responses.
3. IF the Access_Token or the Sandbox_Key is not available server-side when a new-route Sandbox_Gateway request is required, THEN THE BFF_Layer SHALL NOT send the outbound Sandbox_Gateway request and SHALL return an error response whose status indicates the request could not be authenticated, without including the value of the Access_Token or the Sandbox_Key.
4. WHEN the Sandbox_Gateway returns an Error_Body to a new BFF route, THE BFF_Layer SHALL forward only the `status` and the `error` code to the Browser_Client so the UI can present an outcome-specific message, and SHALL NOT include the value of the Access_Token or the Sandbox_Key in the forwarded response.
5. WHERE a new capability mutates data (open account, close account, create or delete a Saved_Payee, create or cancel a Scheduled_Transfer, or update a CustomerProfile), THE BFF_Layer SHALL rely on the Sandbox_Gateway ownership checks for owner-scoping to the authenticated Customer and SHALL forward the Sandbox_Gateway authorization outcome status to the Browser_Client without including the value of the Access_Token or the Sandbox_Key.
6. IF a Browser_Client request to a new `/api/bff/*` route includes a client-supplied `Authorization` header or `X-Sandbox-Key` header, THEN THE BFF_Layer SHALL ignore the client-supplied values and SHALL attach the server-side Access_Token and Sandbox_Key to the outbound Sandbox_Gateway request instead.
7. WHEN a new `/api/bff/*` route returns any response to the Browser_Client, THE BFF_Layer SHALL return only the data required by the requesting view and the forwarded `status` and `error` code, and SHALL NOT return the raw Sandbox_Gateway request headers.

### Requirement 10: Resilience and Graceful Degradation for New Views

**User Story:** As a Customer, I want the new screens to stay usable when the sandbox is slow or unavailable, so that I am never left with a broken screen.

#### Acceptance Criteria

1. THE Banking_App SHALL provide a distinct loading state, empty state, and error state, built from the shared LoadingState, EmptyState, and ErrorState components, for each view introduced by this spec that depends on Sandbox_Gateway data.
2. WHILE a Sandbox_Gateway request for a view introduced by this spec is in progress, THE Banking_App SHALL display a loading state for the affected region within 300 milliseconds of initiating the request.
3. IF a Sandbox_Gateway request for a view introduced by this spec fails due to a network or connectivity error, THEN THE Banking_App SHALL display a connectivity error message and a retry action that re-initiates the failed request.
4. IF a Sandbox_Gateway request for a view introduced by this spec does not complete within 10 seconds, THEN THE Banking_App SHALL cancel the request, display a timeout error message, and display a retry action that re-initiates the request.
5. IF a Sandbox_Gateway request for a view introduced by this spec returns an error status, THEN THE Banking_App SHALL display an observable error indication visible to the Customer that reflects the `error` code from the Error_Body, SHALL retain any previously loaded data for that view, and SHALL keep navigation to all other views available.
6. IF the Sandbox_Gateway responds with HTTP 429 for any view introduced by this spec, THEN THE Banking_App SHALL display an observable rate-limit message visible to the Customer and SHALL NOT retry automatically before a delay of at least 60 seconds.
7. WHEN a Sandbox_Gateway request for a view introduced by this spec returns a successful response containing zero items for the affected view, THE Banking_App SHALL display that view's empty state and SHALL NOT display its loading or error state.

### Requirement 11: Environment-Driven Configuration for New Routes

**User Story:** As an operator, I want the new routes to use the same environment-driven configuration as v1, so that the same build targets a local or hosted sandbox without code changes.

#### Acceptance Criteria

1. WHEN a new BFF route introduced by this spec issues a Sandbox_Gateway request, THE BFF_Layer SHALL resolve the Sandbox_Gateway base URL and the Sandbox_Key from Environment_Config.
2. THE Banking_App SHALL NOT contain literal Sandbox_Gateway URLs, Identity_Provider URLs, or Sandbox_Key values in any source added by this spec.
3. WHERE this spec adds a new required Environment_Config value, THE Banking_App SHALL document that value in the environment example file with a placeholder value.
4. WHERE this spec adds a new required Environment_Config value, IF that value is missing, an empty string, or a whitespace-only string when the Banking_App starts, THEN THE Banking_App SHALL abort startup without serving requests and SHALL report a configuration error naming the value.

### Requirement 12: Testability with Mocked Sandbox Responses

**User Story:** As a developer, I want the new features covered by tests backed by mocked sandbox responses, so that each outcome and failure mode is verifiable without the live sandbox.

#### Acceptance Criteria

1. THE Banking_App SHALL support unit and integration tests for each capability introduced by this spec — correct-balance display with Manual_Refresh, Account_Details_View, Account_Management, transaction-history improvements, Saved_Payee, Scheduled_Transfer, Profile_Page, and the shared AppHeader and Currency_Formatter — that execute to a pass or fail result using mocked Sandbox_Gateway responses and without issuing any network request to the live Sandbox_Gateway.
2. WHEN a Sandbox_Gateway request for a view introduced by this spec is pending, THE Banking_App SHALL provide a test asserting the view's loading state; WHEN such a request resolves with an empty result set, THE Banking_App SHALL provide a test asserting the view's empty state; and WHEN such a request resolves as a failure or does not complete within its timeout, THE Banking_App SHALL provide a test asserting the view's error state with an observable error indication visible to the Customer.
3. WHERE an Account_Management, Saved_Payee, Scheduled_Transfer, or CustomerProfile-update request maps a Sandbox_Gateway status to a UI outcome state, THE Banking_App SHALL provide a test that supplies the corresponding mocked response for each applicable status among 201/202 success, 403, 409, 401, and 429 and asserts a distinct, observable outcome state for that status.
4. THE Banking_App SHALL provide a test asserting that the Access_Token and the Sandbox_Key never appear in any Browser_Client-facing response from any BFF route introduced by this spec.
5. THE Banking_App SHALL provide a test asserting that every Browser_Client data request introduced by this spec targets a same-origin `/api/bff/*` route and never the Sandbox_Gateway origin directly.
6. THE Banking_App SHALL provide tests asserting that the transferValidation rules applied on the client for Saved_Payee creation and for Scheduled_Transfer submission match the rules enforced by the corresponding BFF_Layer routes.
