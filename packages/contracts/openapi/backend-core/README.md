# Backend Core OpenAPI

`openapi.json` is generated from `@bridge/backend` during `npm run build --workspace @bridge/backend`.

This directory owns the M5 C3 Backend REST API contract for `/api/v1`.

The artifact is generated from NestJS route and Swagger decorators in
`services/backend/src`, then committed as the published contract. CP-9 acceptance
requires the generated file to stay synchronized with the actual application
routes; see `services/backend/test/integration/m5-openapi-contract.spec.ts` and
`packages/contracts/cp9-svc-api-acceptance.v1.json`.

Breaking REST changes must be published under a new URL version. The existing
`/api/v1` contract remains stable for consumers.
