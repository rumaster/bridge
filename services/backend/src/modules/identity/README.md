# Identity Module M5

This directory contains the M5 implementation for SVC-IDN:

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
- M5 login provider registry in `identity-service.mjs`:
  - `createTelegramLoginProvider()` is the only enabled MVP provider and keeps
    using `login_codes.purpose = 'telegram_login'`.
  - `createUnavailableEmailLoginProvider()` reserves the future email provider
    with `contactType = 'email'` and `codePurpose = 'email_login'`, but always
    stays disabled in MVP.
  - Future email login must be connected by registering an enabled provider with
    the same provider shape (`id`, `contactType`, `codePurpose`,
    `deliverLoginCode`). Do not add email login endpoints to C3.auth v1; publish
    a new compatible contract version when the provider is actually enabled.
- Session UX operations:
  - `GET /api/v1/users/:id/sessions` lists active, not expired, not revoked
    sessions for an organization user without exposing `token_hash`.
  - `POST /api/v1/users/:id/sessions:revoke` revokes all active sessions for
    that user.
  - `POST /api/v1/auth/logout` revokes the current session and clears the
    `bridge_session` cookie.

Database extension points:

- `login_codes.purpose` accepts `telegram_login` and the reserved
  `email_login` purpose.
- `invitations.contact_type` accepts `telegram` and `email` so invitation-based
  bootstrap is not coupled to a single messenger.
