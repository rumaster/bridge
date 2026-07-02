# C3.auth

`c3.auth.openapi.json` freezes the M0 public REST contract for Identity Platform.
The contract is served under `/api/v1` and covers:

- `POST /auth/login/telegram/start`
- `POST /auth/login/telegram/verify`
- `POST /auth/logout`
- `GET /auth/session`

M0 intentionally publishes DTOs and mock-compatible response shapes only. Real
Telegram code generation, `code_hash` persistence/checking, server session
storage and session revocation are M1 responsibilities of SVC-IDN.
