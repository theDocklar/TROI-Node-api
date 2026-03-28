# Backend Architecture

## System Overview

```
Frontend (React/Next.js)
        |
        | HTTPS + Bearer JWT
        v
  Express 5 REST API  (src/server.js → src/app.js)
        |
        |------ MongoDB Atlas (Mongoose 9)
        |         Users, Shops, MetaAccounts, GoogleAccounts
        |
        |------ Shopify Partner API  (OAuth2 + HMAC)
        |------ Meta Graph API       (OAuth2, long-lived token)
        └------ Google Ads API       (OAuth2, refresh token)
```

---

## Request Lifecycle

```
Incoming request
    → CORS middleware
    → JSON body parser
    → Route match (app.js)
        → auth middleware (src/middleware/auth.js)
            → verify Bearer JWT
            → attach req.user = { id, email }
        → Route handler (src/routes/*.js)
            → query MongoDB (scoped to req.user.id)
            → call platform API if needed
            → return JSON response
```

---

## Auth Architecture

- **Registration:** bcrypt hash (cost 10) stored in `User.password`; JWT (7-day expiry) returned immediately
- **Sign-in:** bcrypt compare → JWT issued
- **Protected routes:** `auth` middleware extracts `Authorization: Bearer <token>`, verifies with `JWT_SECRET`, attaches `req.user`
- **No refresh tokens for app JWT:** token is long-lived (7 days); client must re-authenticate after expiry

---

## OAuth Flow per Platform

### Shopify
1. `GET /shopify/connect?shop=<domain>` — generate random hex `state`, redirect to Shopify OAuth
2. `GET /shopify/callback` — verify `state`, verify HMAC signature, validate timestamp (< 10 min), exchange code for permanent access token
3. Upsert `Shop` document for `userId + shopDomain`

Security: HMAC verification of all query params, timestamp check, state param

### Meta (Facebook Ads)
1. `GET /meta/connect` — generate state, redirect to Meta OAuth dialog
2. `GET /meta/callback` — verify state, exchange short-lived code for long-lived token (60-day), fetch first active ad account
3. Upsert `MetaAccount` document for `userId`

Security: state param validation

### Google Ads
1. `GET /google/connect` — generate state, redirect to Google OAuth with `offline` access_type
2. `GET /google/callback` — verify state, exchange code for access + refresh tokens, store `tokenExpiresAt`
3. Upsert `GoogleAccount` document for `userId`
4. On each `/campaigns` request: check `tokenExpiresAt - 60s`, auto-refresh if needed

Security: state param validation, token expiry tracking

---

## Data Model Relationships

```
User
 └── _id (userId)
      |
      ├── Shop          (userId, shopDomain, accessToken, shopName, currency, plan)
      ├── MetaAccount   (userId, adAccountId, accessToken)
      └── GoogleAccount (userId, customerId, accessToken, refreshToken, tokenExpiresAt)
```

- All platform models reference `userId` (not a Mongoose ref — queried by plain equality)
- `Shop` has a compound unique index on `(userId, shopDomain)` — supports multi-store at model level
- Routes currently use `findOne({ userId })` — only one store per user in practice

---

## Token Lifecycle per Platform

| Platform | Token type      | Expiry        | Renewal strategy                          |
|----------|----------------|---------------|-------------------------------------------|
| Shopify  | Permanent       | Never         | Re-connect required only on revocation    |
| Meta     | Long-lived      | ~60 days      | User must re-connect; no auto-refresh     |
| Google   | Short-lived     | ~1 hour       | Auto-refresh using stored `refreshToken`  |

---

## Data Shape Contract

All platform data endpoints return the same shape for consistent frontend consumption:

```json
{
  "dailySpend": [{ "date": "YYYY-MM-DD", "spend": 0.00 }],
  "dailyRevenue": [{ "date": "YYYY-MM-DD", "revenue": 0.00 }]
}
```

---

## Known Architectural Constraints

1. **In-memory OAuth state store** — state params stored in a plain JS `Map` per process. Works for single-process dev; will break under multiple processes or restarts.
2. **One Shopify store per user** — `Shop` model supports multiple (compound index) but routes use `findOne({ userId })`, returning only the first match.
3. **No test suite** — `package.json` has a placeholder test script only.
4. **CORS open** — currently allows all origins.
5. **No rate limiting** — all endpoints are unthrottled.
6. **Meta token expiry not tracked** — 60-day tokens are stored but expiry date is not persisted; no proactive renewal.

---

## Production Readiness Gaps

| Gap                        | Solution                                          |
|----------------------------|---------------------------------------------------|
| In-memory OAuth state      | Redis (e.g. `ioredis`) with TTL                  |
| Open CORS                  | Restrict to known frontend origin(s)              |
| No rate limiting           | `express-rate-limit` on auth and OAuth routes     |
| No test suite              | Jest + supertest integration tests                |
| Meta token renewal         | Persist `tokenExpiresAt`, schedule refresh        |
| Single store per user      | Update routes to support `shopDomain` selection   |
| No request validation      | `zod` or `express-validator` on all POST routes   |
| No structured logging      | `pino` or `winston` with log levels               |

---

## Subagent Workflow

This project uses Claude Code subagents for development tasks:

- **General-purpose subagent** — writing and editing source files, implementing features, fixing bugs
- **Explore subagent** — reading and mapping the codebase, understanding existing patterns before changes
- **Plan subagent** — designing new features, evaluating architectural trade-offs, producing implementation plans

Subagents are AI coding agents invoked through the Claude Code CLI. They are not part of the runtime application.
