-- up migration

ALTER TABLE users
  ADD COLUMN telegram_id bigint;

CREATE UNIQUE INDEX users_telegram_id_idx
  ON users (telegram_id)
  WHERE telegram_id IS NOT NULL;

COMMENT ON COLUMN users.telegram_id IS
  'Numeric Telegram private chat_id used by Bot API sendMessage for login codes.';

-- down migration

DROP INDEX IF EXISTS users_telegram_id_idx;

ALTER TABLE IF EXISTS users
  DROP COLUMN IF EXISTS telegram_id;
