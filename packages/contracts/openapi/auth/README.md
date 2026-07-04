# C3.auth

`c3.auth.openapi.json` freezes the M1 public REST contract for Identity Platform.
The contract is served under `/api/v1` and covers:

- `POST /auth/login/telegram/start`
- `POST /auth/login/telegram/verify`
- `POST /auth/logout`
- `GET /auth/session`

M1 uses Telegram one-time code challenges, stores only `code_hash`, consumes
`login_codes` once, issues opaque server session tokens, and stores only
`auth_sessions.token_hash`.

M5 keeps C3.auth v1 frozen. The email login fallback is only an internal
extension point for now: `login_codes.purpose = email_login` is reserved and the
Identity provider registry contains a disabled email provider, but no email
login endpoint is exposed in MVP.
