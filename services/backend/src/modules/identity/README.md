# Identity Module M0

This directory contains the M0 skeleton for SVC-IDN:

- DTO validators for C3.auth request payloads.
- Stub endpoint handlers for `start`, `verify`, `logout` and `session`.
- Integration with the shared mock `AuthGuard` from `src/common/auth`.

M0 deliberately does not implement real Telegram login flow, `login_codes`,
`code_hash` storage/checking, `auth_sessions` persistence, session expiration or
session revocation. Those checks belong to M1.
