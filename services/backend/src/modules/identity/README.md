# Identity Module M1

This directory contains the M1 implementation for SVC-IDN:

- Telegram one-time code login with normalized `telegramUsername`.
- `login_codes` persistence with `code_hash`, TTL, `consumed_at`, attempt count
  and lockout metadata.
- Mock Telegram delivery adapter for local/CI flows until SVC-INT delivery is
  available.
- Server sessions through `auth_sessions` with `token_hash`, `expires_at` and
  `revoked_at`.
- Shared session `AuthGuard` integration for active, not expired and not revoked
  sessions with organization ownership checks.

Full RBAC enforcement and self-service organization bootstrap remain later
Identity milestones.
