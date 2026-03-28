# TROI Backend — Claude Code Reference

## Purpose
Node.js/Express REST API for TROI. Handles user auth and OAuth integrations with Shopify, Meta, and Google Ads. Aggregates daily campaign and order metrics per authenticated user (multi-tenant SaaS).

## Tech Stack
Node.js, Express 5, Mongoose 9 (MongoDB Atlas), jsonwebtoken, bcryptjs, node-fetch, cors, dotenv, nodemon

## Key Architectural Rules
- All data must be scoped to `req.user.id` — no unscoped queries ever
- Platform connections use upsert (`findOneAndUpdate` with `upsert: true`) — no duplicate records
- All platform data endpoints return `dailySpend[]` and `dailyRevenue[]` arrays — keep this shape consistent
- OAuth state params are stored in-memory (`Map`) — one state store per route file

## File Structure
```
src/
  server.js          entry point
  app.js             middleware + route mounting
  config/db.js       MongoDB connection
  middleware/auth.js JWT verify, attaches req.user
  models/            User, Shop, MetaAccount, GoogleAccount
  routes/            auth, shopify, meta, google
docs/                architecture.md, changelog.md, context.md
```

## Coding Standards
- Never hardcode user IDs, tokens, or secrets
- Keep route handlers thin — move reusable logic to helpers
- Validate all inputs before using them in queries or API calls
- Update `docs/context.md` and `docs/changelog.md` after meaningful changes

## Docs
See `docs/` for architecture details, changelog, and current project context.

## Subagent Workflow
Three subagent types are used with this project:
- **Explore** — read and map code before making changes
- **Plan** — design features and evaluate trade-offs
- **General-purpose** — implement, edit, and fix code
Always run Explore before Plan or implementation on unfamiliar areas.
