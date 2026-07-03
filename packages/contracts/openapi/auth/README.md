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
