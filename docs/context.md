# Project Context

This is a living document. Update it after every meaningful change to the backend.

Last updated: 2026-03-28

---

## Current State

Version: **0.1.0** — initial working backend

---

## What Is Fully Working

- User registration and sign-in (JWT auth, bcrypt hashing)
- Protected routes via JWT middleware (`req.user.id` attached)
- Shopify OAuth2 connect/disconnect, order history (paginated), product listing
- Meta OAuth2 connect/disconnect, campaign metrics with daily spend
- Google Ads OAuth2 connect/disconnect, campaign metrics with daily spend (auto-refresh token)
- All platform data returns consistent `dailySpend[]` / `dailyRevenue[]` arrays
- Upsert pattern: reconnecting a platform updates the existing record without creating duplicates
- Health check endpoint (`GET /`)

---

## Active Platform Integrations

| Platform | Status   | Token Type    | Notes                                  |
|----------|----------|---------------|----------------------------------------|
| Shopify  | Working  | Permanent     | HMAC verified, paginated orders API    |
| Meta     | Working  | 60-day        | Long-lived token exchanged on callback |
| Google   | Working  | Short + refresh | Auto-refreshes 60s before expiry     |

---

## Known Limitations

1. **In-memory OAuth state store** — `Map` per process. Breaks on restart or multi-process deploy.
2. **One Shopify store per user** — routes use `findOne({ userId })`, ignores `shopDomain`.
3. **No test suite** — only a placeholder script in `package.json`.
4. **CORS open** — `cors()` with no origin restriction; all origins accepted.
5. **No rate limiting** — auth and OAuth endpoints are unthrottled.
6. **Meta token expiry not tracked** — no `tokenExpiresAt` stored; silent failure after 60 days.
7. **No request validation** — route handlers do minimal input validation.

---

## What Is Needed Before Production

- [ ] Replace in-memory OAuth state with Redis (TTL-backed)
- [ ] Restrict CORS to known frontend origin
- [ ] Add rate limiting (`express-rate-limit`) on auth and OAuth routes
- [ ] Build integration test suite (Jest + supertest)
- [ ] Persist and track Meta token expiry; notify user before it lapses
- [ ] Update Shopify routes to support multiple stores per user
- [ ] Add structured logging (pino or winston)
- [ ] Add request validation (zod or express-validator)

---

## How to Update This Document

After any meaningful change, update:
- **Last updated** date at the top
- The relevant section(s) below (add to "What Is Fully Working", remove from "Known Limitations" if fixed, etc.)
- Add an entry to `docs/changelog.md` under `[Unreleased]`
