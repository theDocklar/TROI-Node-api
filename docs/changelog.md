# Changelog

All notable changes to the TROI backend will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [0.1.0] - 2026-03-28

### Added
- Express 5 REST API with MongoDB Atlas (Mongoose 9)
- JWT-based user registration and authentication
- Shopify OAuth2 with HMAC verification and timestamp validation
- Meta (Facebook Ads) OAuth with long-lived token exchange
- Google Ads OAuth with refresh token auto-renewal
- Daily aggregated orders and campaign metrics endpoints
- User-scoped data isolation (multi-tenant)
- Disconnect endpoints for all platforms
- Health check endpoint
