# ADR-0003: Built-in accounts, revocable JWT sessions, and mandatory TOTP for staff

- **Status:** Accepted, 2026-10-06
- **Owner:** onichajude

## Context
Staff accounts can see every driver's live location, which is high-sensitivity data. The product is self-hosted per company, so there's no corporate identity provider to rely on.

## Options
1. **Built-in accounts (chosen)**
2. External identity provider (Auth0, Entra ID, Google)
3. Email magic links
4. Server-side sessions with cookies instead of JWT

## Decision
- **Passwords:** hashed with scrypt.
- **Sessions:** JWT (HS256, 14 days), carrying a `token_version` that the server checks on every request. Bumping it revokes all of a user's sessions on a password change or reset, deactivation, erasure or two-step change.
- **Staff two-step login:** TOTP (RFC 6238) authenticator codes are **required** for staff (`REQUIRE_STAFF_MFA`, default on). This is enforced on the API and the WebSocket, and codes can't be reused.
- **Drivers:** password only, since they can only reach their own data.

## Consequences
- **No email or SMS dependency.** Recovery is done by an admin, so at least two admins are needed (risk R-11).
- **Browser tokens live in localStorage** (risk R-01, mitigated by CSP). Moving to httpOnly cookies with CSRF protection is the planned improvement.
- **Revisit when:** an enterprise customer needs SSO, or drivers can access more than their own data.
