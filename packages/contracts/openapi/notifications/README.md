# C10 Notifications

`c10.notifications.openapi.json` freezes the M0 public Notification REST
contract under `/api/v1` for SVC-NOTIF consumers.

The matching WebSocket event schema is
`packages/contracts/events/notification-created.schema.json`. Producer-side
event expectations for services that generate notifications are frozen in
`packages/contracts/events/notification-trigger.schema.json`.
