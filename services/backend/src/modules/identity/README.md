# Identity Module M4

This directory contains the M4 implementation for SVC-IDN:

- Telegram one-time code login with normalized `telegramUsername`.
- `login_codes` persistence with `code_hash`, TTL, `consumed_at`, attempt count
  and lockout metadata.
- Mock Telegram delivery adapter for local/CI flows until SVC-INT delivery is
  available.
- Server sessions through `auth_sessions` with `token_hash`, `expires_at` and
  `revoked_at`.
- Shared session `AuthGuard` integration for active, not expired and not revoked
  sessions with organization ownership checks.
- Shared `RolesGuard` and `@Roles(...)` decorator for server-side RBAC from
  `user_roles`.
- Platform Operator bootstrap endpoints for provisioning, blocking and first
  Administrator invitation:
  - `POST /api/v1/platform/organizations`
  - `POST /api/v1/platform/organizations/:id/administrators`
  - `POST /api/v1/platform/organizations/:id/block`
- Organization invitations through `POST /api/v1/invitations` and first login
  through `POST /api/v1/invitations/accept`, with `token_hash`, TTL and
  one-time consumption.
- Append-only audit events for provisioning, blocking, invitation creation,
  invitation acceptance and invitation-based session creation.
