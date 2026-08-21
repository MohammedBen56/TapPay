/**
 * Ship List v2 Wave 2 Phase 3: OpenAPI generation from the existing Zod
 * schemas -- converts the request-validation schemas of §10.ts route
 * files) into an OpenAPI 3.0 document via `zod-to-json-schema`. This
 * turns the hand-kept-in-sync risk `packages/shared/src/api.ts`'s own
 * header comment already documents ("hand-kept in sync... not
 * generated") into a generated, type-checked contract for REQUEST
 * shapes -- the same Zod objects that actually validate a request at
 * runtime, so this can't drift the way a hand-written spec could.
 *
 * Deliberately built as a hand-assembled static document
 * (`@fastify/swagger`'s `mode: "static"`), NOT via per-route
 * `schema.body` wiring + `fastify-type-provider-zod`. Every route in this
 * codebase does its own manual `schema.safeParse(request.body)` inside
 * the handler with a typed, project-specific error shape
 * (`{error: "InvalidRequest", message}`) -- wiring Fastify's own
 * AJV-based `schema.body` validation on top would either double-validate
 * or (worse) let Fastify's own default validator intercept a malformed
 * request BEFORE the handler's existing error-shape logic ever runs,
 * changing real behavior across every v1 route for the sake of
 * documentation. Static-mode assembly gets genuine schema generation
 * from the real Zod objects with zero risk to already-tested request
 * handling.
 *
 * Response shapes are intentionally NOT generated here -- they'd need to
 * be derived from `packages/shared/src/api.ts`'s TypeScript interfaces,
 * which `zod-to-json-schema` can't do (it only converts Zod schema
 * objects, and those interfaces were never written as Zod schemas since
 * responses aren't runtime-validated). Documenting request shapes
 * accurately is the higher-value half for an integrating bank partner
 * anyway -- knowing what to send matters more than a formal response
 * schema when the response DTOs are already fully typed in
 * `packages/shared`.
 */
import type { OpenAPIV3 } from "openapi-types";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import { changePasswordBodySchema, loginBodySchema, logoutBodySchema, refreshBodySchema } from "./routes/auth.js";
import { openAccountBodySchema } from "./routes/accounts.js";
import { accountIdQuerySchema, statementQuerySchema, transactionsQuerySchema, updateMeBodySchema } from "./routes/me.js";
import { transferBodySchema } from "./routes/transfers.js";
import { createBodySchema as createBeneficiaryBodySchema, updateBodySchema as updateBeneficiaryBodySchema } from "./routes/beneficiaries.js";
import { billPaymentsQuerySchema, categoryQuerySchema, payBillBodySchema } from "./routes/billPayments.js";
import { createDisputeBodySchema } from "./routes/disputes.js";
import { createGoalBodySchema, fundGoalBodySchema } from "./routes/goals.js";
import { createMoneyRequestBodySchema } from "./routes/moneyRequests.js";
import { registerPushTokenBodySchema } from "./routes/pushTokens.js";
import { createSupportRequestBodySchema } from "./routes/support.js";

function bodyFrom(schema: ZodTypeAny): OpenAPIV3.RequestBodyObject {
  return {
    required: true,
    content: {
      "application/json": {
        schema: zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as OpenAPIV3.SchemaObject,
      },
    },
  };
}

/** Query-param schemas are Zod *objects* -- flatten their JSON Schema
 * `properties`/`required` into individual OpenAPI `parameters` entries,
 * which is how query params (not a request body) are represented. */
function queryParamsFrom(schema: ZodTypeAny): OpenAPIV3.ParameterObject[] {
  const json = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as OpenAPIV3.SchemaObject;
  const properties = json.properties ?? {};
  const required = new Set(json.required ?? []);
  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: propSchema as OpenAPIV3.SchemaObject,
  }));
}

const bearerAuth: OpenAPIV3.SecurityRequirementObject[] = [{ bearerAuth: [] }];

export function buildOpenApiDocument(): OpenAPIV3.Document {
  return {
    openapi: "3.0.3",
    info: {
      title: "TapPay API",
      version: "1.0.0",
      description:
        "TapPay's live v2 neobank API. A mock ledger -- see CLAUDE.md for the full scope statement. " +
        "Every request shape below is generated directly from the same Zod schemas that validate it at " +
        "runtime (server/src/openapi.ts), so it cannot drift from what the server actually accepts. " +
        "Response shapes are documented informally in each operation's description; the canonical typed " +
        "response contract lives in packages/shared/src/api.ts.",
    },
    servers: [{ url: "/v1", description: "Live v2 API (Ship List v2 Wave 2 Phase 3)" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    paths: {
      "/auth/login": {
        post: {
          operationId: "login",
          summary: "Authenticate with a customer_id + password",
          description: "Returns a JWT access token + rotating opaque refresh token. Returns one generic 401 for every failure mode (unknown customer_id, wrong password, locked account) -- see CLAUDE.md §5.",
          tags: ["auth"],
          requestBody: bodyFrom(loginBodySchema),
          responses: { "200": { description: "LoginResponse (packages/shared/src/api.ts)" }, "401": { description: "InvalidCredentials" } },
        },
      },
      "/auth/refresh": {
        post: {
          operationId: "refresh",
          summary: "Rotate a refresh token for a new access token",
          description: "Presenting an already-rotated token revokes the entire session family (theft-detection, CLAUDE.md §5).",
          tags: ["auth"],
          requestBody: bodyFrom(refreshBodySchema),
          responses: { "200": { description: "RefreshResponse" }, "401": { description: "InvalidRefreshToken" } },
        },
      },
      "/auth/logout": {
        post: {
          operationId: "logout",
          summary: "Revoke a refresh token",
          tags: ["auth"],
          security: bearerAuth,
          requestBody: bodyFrom(logoutBodySchema),
          responses: { "204": { description: "No Content" } },
        },
      },
      "/auth/change-password": {
        post: {
          operationId: "changePassword",
          summary: "Change the signed-in customer's password",
          description: "Revokes every active session for the user afterward, including the caller's own.",
          tags: ["auth"],
          security: bearerAuth,
          requestBody: bodyFrom(changePasswordBodySchema),
          responses: { "204": { description: "No Content" }, "400": { description: "InvalidRequest -- wrong current password or new password too short" } },
        },
      },
      "/auth/sessions": {
        get: {
          operationId: "listSessions",
          summary: "List the signed-in customer's active sessions",
          tags: ["auth"],
          security: bearerAuth,
          responses: { "200": { description: "SessionsResponse" } },
        },
      },
      "/auth/sessions/{id}": {
        delete: {
          operationId: "revokeSession",
          summary: "Revoke one of the signed-in customer's own sessions",
          tags: ["auth"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "No Content" }, "404": { description: "NotFound -- not the caller's own session" } },
        },
      },
      "/accounts": {
        get: {
          operationId: "listAccounts",
          summary: "List the signed-in customer's own accounts (checking, and savings once opened)",
          tags: ["accounts"],
          security: bearerAuth,
          responses: { "200": { description: "AccountsResponse" } },
        },
        post: {
          operationId: "openAccount",
          summary: "Open a savings account",
          description: "`savings` is the only client-choosable account_type -- checking always exists already.",
          tags: ["accounts"],
          security: bearerAuth,
          requestBody: bodyFrom(openAccountBodySchema),
          responses: { "201": { description: "AccountSummary (OpenAccountResponse)" }, "409": { description: "DuplicateAccount" } },
        },
      },
      "/me": {
        get: {
          operationId: "getMe",
          summary: "The signed-in customer's own profile",
          tags: ["me"],
          security: bearerAuth,
          parameters: queryParamsFrom(accountIdQuerySchema),
          responses: { "200": { description: "MeResponse" } },
        },
        patch: {
          operationId: "updateMe",
          summary: "Toggle the caller's own round-up savings preference",
          tags: ["me"],
          security: bearerAuth,
          requestBody: bodyFrom(updateMeBodySchema),
          responses: { "200": { description: "MeResponse" } },
        },
      },
      "/me/data-export": {
        get: {
          operationId: "dataExport",
          summary: "Bundle of the caller's own profile/transactions/bill-payments/beneficiaries",
          tags: ["me"],
          security: bearerAuth,
          parameters: queryParamsFrom(accountIdQuerySchema),
          responses: { "200": { description: "DataExportResponse" } },
        },
      },
      "/accounts/me/balance": {
        get: {
          operationId: "getBalance",
          summary: "The signed-in customer's own available balance",
          tags: ["me"],
          security: bearerAuth,
          parameters: queryParamsFrom(accountIdQuerySchema),
          responses: { "200": { description: "BalanceResponse" } },
        },
      },
      "/accounts/me/transactions": {
        get: {
          operationId: "listTransactions",
          summary: "Keyset-paginated transaction history",
          tags: ["me"],
          security: bearerAuth,
          parameters: queryParamsFrom(transactionsQuerySchema),
          responses: { "200": { description: "TransactionsResponse" } },
        },
      },
      "/accounts/me/statement": {
        get: {
          operationId: "getStatement",
          summary: "Date-ranged, itemized statement with opening/closing balance",
          tags: ["me"],
          security: bearerAuth,
          parameters: queryParamsFrom(statementQuerySchema),
          responses: { "200": { description: "StatementResponse" }, "400": { description: "malformed date or from > to" } },
        },
      },
      "/transfers": {
        post: {
          operationId: "createTransfer",
          summary: "Settle a transfer to a RIB or a saved beneficiary",
          description: "tx_uuid is client-chosen and idempotent -- resubmitting the same tx_uuid with identical parameters returns the original settlement. Accepts an optional Idempotency-Key header, echoed back on success.",
          tags: ["transfers"],
          security: bearerAuth,
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
          requestBody: bodyFrom(transferBodySchema),
          responses: {
            "200": { description: "CreateTransferResponse" },
            "409": { description: "TxUuidConflict | ReservationExpired | InsufficientFunds" },
          },
        },
      },
      "/transfers/{txUuid}": {
        get: {
          operationId: "getTransfer",
          summary: "Fetch a settled transfer (receipt) -- either party can fetch their own side",
          tags: ["transfers"],
          security: bearerAuth,
          parameters: [{ name: "txUuid", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "TransferDetailResponse" }, "404": { description: "no transaction with this tx_uuid for any of the caller's own accounts" } },
        },
      },
      "/lookup/rib/{rib}": {
        get: {
          operationId: "lookupRib",
          summary: "Pre-send validation -- confirms a RIB resolves to a real account and shows the holder's name",
          tags: ["lookup"],
          security: bearerAuth,
          parameters: [{ name: "rib", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]{24}$" } }],
          responses: { "200": { description: "RibLookupResponse" }, "404": { description: "unknown or malformed RIB -- identical either way, no enumeration" } },
        },
      },
      "/beneficiaries": {
        get: {
          operationId: "listBeneficiaries",
          summary: "List the signed-in customer's saved beneficiaries",
          tags: ["beneficiaries"],
          security: bearerAuth,
          responses: { "200": { description: "BeneficiariesResponse" } },
        },
        post: {
          operationId: "createBeneficiary",
          summary: "Save a beneficiary by RIB",
          tags: ["beneficiaries"],
          security: bearerAuth,
          requestBody: bodyFrom(createBeneficiaryBodySchema),
          responses: { "201": { description: "CreateBeneficiaryResponse" }, "409": { description: "DuplicateBeneficiary" } },
        },
      },
      "/beneficiaries/{id}": {
        patch: {
          operationId: "updateBeneficiary",
          summary: "Rename a saved beneficiary",
          tags: ["beneficiaries"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: bodyFrom(updateBeneficiaryBodySchema),
          responses: { "200": { description: "UpdateBeneficiaryResponse" } },
        },
        delete: {
          operationId: "deleteBeneficiary",
          summary: "Remove a saved beneficiary",
          tags: ["beneficiaries"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "No Content" } },
        },
      },
      "/billers": {
        get: {
          operationId: "listBillers",
          summary: "List the mock biller catalog, optionally filtered by category",
          tags: ["bill-payments"],
          security: bearerAuth,
          // categoryQuerySchema validates the VALUE of a single "category"
          // param (z.enum(...).optional()), not a whole query object --
          // queryParamsFrom (built for object schemas) doesn't apply here.
          parameters: [
            {
              name: "category",
              in: "query",
              required: false,
              schema: zodToJsonSchema(categoryQuerySchema, { target: "openApi3", $refStrategy: "none" }) as OpenAPIV3.SchemaObject,
            },
          ],
          responses: { "200": { description: "BillersResponse" } },
        },
      },
      "/bill-payments": {
        get: {
          operationId: "listBillPayments",
          summary: "Keyset-paginated bill-payment history",
          tags: ["bill-payments"],
          security: bearerAuth,
          parameters: queryParamsFrom(billPaymentsQuerySchema),
          responses: { "200": { description: "BillPaymentsResponse" } },
        },
        post: {
          operationId: "payBill",
          summary: "Settle a bill payment",
          description: "Same tx_uuid idempotency as /transfers. Accepts an optional Idempotency-Key header, echoed back on success.",
          tags: ["bill-payments"],
          security: bearerAuth,
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }],
          requestBody: bodyFrom(payBillBodySchema),
          responses: { "200": { description: "PayBillResponse" }, "409": { description: "TxUuidConflict | InsufficientFunds" } },
        },
      },
      "/bill-payments/{txUuid}": {
        get: {
          operationId: "getBillPayment",
          summary: "Fetch a settled bill payment",
          tags: ["bill-payments"],
          security: bearerAuth,
          parameters: [{ name: "txUuid", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "BillPaymentDetailResponse" }, "404": { description: "not found for the caller's own account" } },
        },
      },
      "/goals": {
        get: {
          operationId: "listGoals",
          summary: "List the signed-in customer's financial goals",
          tags: ["goals"],
          security: bearerAuth,
          responses: { "200": { description: "GoalsResponse" } },
        },
        post: {
          operationId: "createGoal",
          summary: "Create a financial goal",
          description: "A goal earmarks an amount inside the customer's one real savings account -- it is not a separate ledger account.",
          tags: ["goals"],
          security: bearerAuth,
          requestBody: bodyFrom(createGoalBodySchema),
          responses: { "201": { description: "Goal" } },
        },
      },
      "/goals/{id}/fund": {
        post: {
          operationId: "fundGoal",
          summary: "Increment a goal's saved_amount (bookkeeping only -- no money movement)",
          tags: ["goals"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: bodyFrom(fundGoalBodySchema),
          responses: { "200": { description: "Goal" }, "404": { description: "not found for the caller's own account" } },
        },
      },
      "/goals/{id}": {
        delete: {
          operationId: "deleteGoal",
          summary: "Delete a financial goal",
          tags: ["goals"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "deleted" }, "404": { description: "not found for the caller's own account" } },
        },
      },
      "/subscriptions": {
        get: {
          operationId: "listSubscriptions",
          summary: "Detected recurring payments (read-only pattern detection, no new stored data)",
          tags: ["subscriptions"],
          security: bearerAuth,
          parameters: queryParamsFrom(accountIdQuerySchema),
          responses: { "200": { description: "SubscriptionsResponse" } },
        },
      },
      "/support-requests": {
        get: {
          operationId: "listSupportRequests",
          summary: "List the caller's own support requests",
          tags: ["support"],
          security: bearerAuth,
          responses: { "200": { description: "SupportRequestsResponse" } },
        },
        post: {
          operationId: "createSupportRequest",
          summary: "File a support request",
          tags: ["support"],
          security: bearerAuth,
          requestBody: bodyFrom(createSupportRequestBodySchema),
          responses: { "201": { description: "SupportRequest" } },
        },
      },
      "/disputes": {
        get: {
          operationId: "listDisputes",
          summary: "List the caller's own disputes",
          tags: ["disputes"],
          security: bearerAuth,
          responses: { "200": { description: "DisputesResponse" } },
        },
        post: {
          operationId: "createDispute",
          summary: "Flag a transaction for review -- never touches money movement",
          tags: ["disputes"],
          security: bearerAuth,
          requestBody: bodyFrom(createDisputeBodySchema),
          responses: {
            "201": { description: "Dispute" },
            "404": { description: "no transaction with this tx_uuid for the caller's own account" },
            "409": { description: "DuplicateDispute -- already flagged" },
          },
        },
      },
      "/money-requests": {
        get: {
          operationId: "listMoneyRequests",
          summary: "The caller's own incoming (owed to them) and outgoing (they're owed) money requests",
          tags: ["money-requests"],
          security: bearerAuth,
          responses: { "200": { description: "MoneyRequestsResponse" } },
        },
        post: {
          operationId: "createMoneyRequest",
          summary: "Request money from a specific person, by RIB or saved beneficiary",
          tags: ["money-requests"],
          security: bearerAuth,
          requestBody: bodyFrom(createMoneyRequestBodySchema),
          responses: { "201": { description: "{id}" } },
        },
      },
      "/money-requests/{id}/fulfill": {
        post: {
          operationId: "fulfillMoneyRequest",
          summary: "Pay a money request addressed to the caller -- settles via the same path as POST /transfers",
          tags: ["money-requests"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "FulfillMoneyRequestResponse" },
            "404": { description: "not found, or not addressed to the caller" },
            "409": { description: "already fulfilled or declined" },
          },
        },
      },
      "/money-requests/{id}/decline": {
        post: {
          operationId: "declineMoneyRequest",
          summary: "Decline a money request addressed to the caller",
          tags: ["money-requests"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "declined" }, "404": { description: "not found, not addressed to the caller, or already resolved" } },
        },
      },
      "/push-tokens": {
        post: {
          operationId: "registerPushToken",
          summary: "Register (or refresh) the caller's own Expo push token",
          tags: ["notifications"],
          security: bearerAuth,
          requestBody: bodyFrom(registerPushTokenBodySchema),
          responses: { "204": { description: "registered" } },
        },
      },
      "/notifications": {
        get: {
          operationId: "listNotifications",
          summary: "The caller's own recent in-app notifications",
          tags: ["notifications"],
          security: bearerAuth,
          responses: { "200": { description: "NotificationsResponse" } },
        },
      },
      "/notifications/{id}/read": {
        post: {
          operationId: "markNotificationRead",
          summary: "Mark one of the caller's own notifications read (idempotent)",
          tags: ["notifications"],
          security: bearerAuth,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "marked read (or already was)" } },
        },
      },
    },
  };
}
