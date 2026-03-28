# TROI Backend — Project Specification

## Overview

The TROI backend is a **Node.js/Express REST API** that handles user authentication and OAuth integrations with three advertising/e-commerce platforms: **Shopify**, **Meta (Facebook Ads)**, and **Google Ads**. It aggregates daily campaign and order metrics from each connected platform and exposes them to the TROI frontend.

**Core Responsibilities:**
- User registration, authentication (JWT)
- OAuth flows for Shopify, Meta, and Google
- Fetching and normalising daily campaign spend/revenue from each platform
- Storing connection credentials per user in MongoDB

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Framework | Express.js v5 |
| Database | MongoDB (Atlas) via Mongoose v9 |
| Auth | JWT (jsonwebtoken), bcryptjs |
| HTTP Client | node-fetch v2 |
| CORS | cors v2 |
| Config | dotenv |
| Dev | nodemon |

---

## Project Structure

```
backend/
├── src/
│   ├── server.js              # Entry point: initialise Express + DB connection
│   ├── app.js                 # Middleware registration, route mounting, CORS, /health
│   ├── config/
│   │   └── db.js              # MongoDB Atlas connection
│   ├── middleware/
│   │   └── auth.js            # JWT verification middleware
│   ├── models/
│   │   ├── User.js            # User credentials + onboarding flag
│   │   ├── Shop.js            # Shopify store connection
│   │   ├── MetaAccount.js     # Meta/Facebook ad account connection
│   │   └── GoogleAccount.js   # Google Ads account connection
│   └── routes/
│       ├── auth.js            # Register, sign-in, profile
│       ├── shopify.js         # Shopify OAuth + orders/products
│       ├── meta.js            # Meta OAuth + campaign insights
│       └── google.js          # Google Ads OAuth + campaign metrics
├── .env                       # Secrets (not committed)
├── .env.example               # Template with placeholder values
└── package.json
```

---

## Database Models

### User (`models/User.js`)
| Field | Type | Notes |
|-------|------|-------|
| `name` | String | Required, trimmed |
| `email` | String | Required, unique, lowercase |
| `password` | String | Hashed with bcrypt (cost 10), min 8 chars |
| `onboarded` | Boolean | Default: `false` |
| `createdAt/updatedAt` | Date | Auto-managed |

Instance method: `comparePassword(plain)` — validates against stored hash.

---

### Shop (`models/Shop.js`)
| Field | Type | Notes |
|-------|------|-------|
| `userId` | ObjectId | ref: User, indexed |
| `shopDomain` | String | e.g. `store.myshopify.com` |
| `accessToken` | String | Shopify permanent access token |
| `shopName` | String | |
| `currency` | String | Default: `USD` |
| `plan` | String | Shopify plan name |
| `installedAt` | Date | |
| `lastSyncedAt` | Date | Updated on each data fetch |

Compound index on `(userId, shopDomain)`.

---

### MetaAccount (`models/MetaAccount.js`)
| Field | Type | Notes |
|-------|------|-------|
| `userId` | ObjectId | ref: User, indexed |
| `adAccountId` | String | Format: `act_xxxx` |
| `accountName` | String | |
| `currency` | String | Default: `USD` |
| `accessToken` | String | Long-lived (60-day expiry) |
| `installedAt` / `lastSyncedAt` | Date | |

---

### GoogleAccount (`models/GoogleAccount.js`)
| Field | Type | Notes |
|-------|------|-------|
| `userId` | ObjectId | ref: User, indexed |
| `customerId` | String | Numeric, no dashes |
| `accountName` | String | |
| `currency` | String | Default: `USD` |
| `accessToken` | String | Short-lived; auto-refreshed |
| `refreshToken` | String | Long-lived; never expires |
| `tokenExpiresAt` | Number | Unix ms timestamp |
| `installedAt` / `lastSyncedAt` | Date | |

---

## API Endpoints

**Base URL:** `http://localhost:5000`

**Auth Header:** `Authorization: Bearer <jwt>` (required on protected routes)

---

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: 'ok' }` |

---

### Authentication (`/api/auth`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | No | Create account → returns `{ token, user }` |
| POST | `/signin` | No | Sign in → returns `{ token, user }` |
| GET | `/me` | Yes | Returns current user profile |

**User object:** `{ id, name, email, onboarded }`

---

### Shopify (`/api/shopify`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/connect?shop=` | Yes | Returns Shopify OAuth authorisation URL |
| POST | `/callback` | Yes | Exchanges OAuth code for access token; saves Shop record |
| GET | `/status` | Yes | Returns `{ connected: bool, shopDomain, shopName }` |
| GET | `/orders?days=60` | Yes | Daily aggregated orders from Shopify Orders API |
| GET | `/products` | Yes | Product catalogue from Shopify Products API |
| POST | `/disconnect` | Yes | Deletes Shop record |

**Orders response:**
```json
{
  "dailyRevenue": [number],
  "dailyOrders": [number],
  "dailyRefundAmount": [number],
  "refundRate": number,
  "days": number
}
```

**Products response:**
```json
{
  "products": [{ "id", "title", "productType", "variants": [{ "sku", "price" }] }]
}
```

**Security:** HMAC signature verification (timing-safe), timestamp validation (±10 min), OAuth state parameter.

---

### Meta (`/api/meta`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/connect` | Yes | Returns Meta OAuth authorisation URL |
| POST | `/callback` | Yes | Exchanges code for long-lived token; saves MetaAccount |
| GET | `/status` | Yes | Returns `{ connected: bool, adAccountId, accountName }` |
| GET | `/campaigns?days=60` | Yes | Daily spend & purchase revenue per campaign |
| POST | `/disconnect` | Yes | Deletes MetaAccount record |

**Campaigns response:**
```json
{
  "campaigns": [{ "id", "name", "channel": "Meta", "dailySpend": [number], "dailyRevenue": [number] }],
  "days": number
}
```

Token handling: exchanges short-lived token for 60-day long-lived token on callback.

---

### Google Ads (`/api/google`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/connect` | Yes | Returns Google OAuth authorisation URL |
| POST | `/callback` | Yes | Stores access + refresh tokens; saves GoogleAccount |
| GET | `/status` | Yes | Returns `{ connected: bool, customerId, accountName }` |
| GET | `/campaigns?days=60` | Yes | Daily spend & conversion value per campaign |
| POST | `/disconnect` | Yes | Deletes GoogleAccount record |

**Campaigns response:**
```json
{
  "campaigns": [{ "id", "name", "channel": "Google", "dailySpend": [number], "dailyRevenue": [number] }],
  "days": number
}
```

Token handling: access token auto-refreshed when within 60 seconds of expiry using refresh token. Costs are in micros (÷ 1,000,000 to get dollars). Uses GAQL for queries.

---

## Authentication & Security

### JWT
- Issued on register/signin: `jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '7d' })`
- `auth.js` middleware verifies token and attaches `req.user = { id, email }`
- Returns `401` for missing, invalid, or expired tokens

### Password Storage
- Hashed with bcryptjs, cost factor 10
- Pre-save hook on User model ensures hashing on every save
- `comparePassword()` instance method used at sign-in

### OAuth State Security
- Random hex state parameter generated per OAuth initiation
- Stored in-memory with expiry; validated on callback
- Expired states cleaned up automatically
- Shopify additionally validates HMAC signature and request timestamp

---

## Platform Integration Notes

| Platform | Token Lifetime | Refresh Strategy |
|----------|---------------|-----------------|
| Shopify | Permanent | N/A |
| Meta | 60 days | Exchange for long-lived on callback |
| Google | ~1 hour | Auto-refresh via refresh token before API calls |

**Data pattern:** All platforms return arrays of daily values (one value per day for the requested `days` window), allowing the frontend to align data across channels.

**Upsert pattern:** Each platform connection uses MongoDB upsert (`findOneAndUpdate`) so reconnecting a previously removed account updates the existing record rather than creating a duplicate.

**Pagination:** Shopify and Meta endpoints paginate through all results (250 items/page for Shopify, cursor-based for Meta).

---

## Environment Variables

Refer to `.env.example` for the full template. Required variables:

```env
# Server
PORT=5000

# Database
MONGODB_URI=mongodb+srv://...

# JWT
JWT_SECRET=

# Shopify
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_REDIRECT_URI=http://localhost:3000/shopify/callback

# Meta
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=http://localhost:3000/meta/callback

# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/google/callback
```

---

## Scripts

```bash
npm start       # Production server
npm run dev     # Dev server with nodemon (hot reload)
npm test        # (not yet implemented)
```

---

## Testing

No automated tests are currently configured. The test script is a placeholder. Recommended areas to cover when tests are added:

- JWT generation and verification
- Duplicate email validation on register
- Password hashing and comparison
- OAuth state parameter lifecycle
- HMAC verification (Shopify)
- Auth middleware (missing/invalid/expired token)
- Model upsert behaviour
- External platform API error handling (502 responses)

---

## Key Architecture Decisions

- **In-memory OAuth state store** — fine for single-process dev; replace with Redis for production scale-out
- **One connection per user per platform** — current design; extendable to multi-account
- **Daily aggregation** — all platform responses use daily arrays for consistent frontend consumption
- **Helper functions per route** — `shopifyRequest()`, `graphRequest()` (Meta), `gaqlSearch()` (Google) encapsulate platform-specific HTTP logic within their route files
- **`lastSyncedAt` timestamp** — tracks freshness of each connection's data without a separate sync log
