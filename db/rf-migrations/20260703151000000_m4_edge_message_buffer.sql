-- up migration

CREATE TABLE edge_message_buffer (
  id uuid PRIMARY KEY,
  endpoint_id uuid NOT NULL,
  sequence_number bigint NOT NULL,
  idempotency_key uuid NOT NULL,
  payload_encrypted bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  ttl timestamptz NOT NULL,
  forwarded_at timestamptz,
  CONSTRAINT edge_message_buffer_sequence_number_positive CHECK (sequence_number > 0),
  CONSTRAINT edge_message_buffer_payload_non_empty CHECK (octet_length(payload_encrypted) > 0),
  CONSTRAINT edge_message_buffer_ttl_after_received_check CHECK (ttl >= received_at),
  CONSTRAINT edge_message_buffer_forwarded_after_received_check CHECK (
    forwarded_at IS NULL OR forwarded_at >= received_at
  )
);

COMMENT ON TABLE edge_message_buffer IS
  'M4 RF-first Edge buffer. Primary personal-data fixation for Russian subjects happens in the RF database before secondary replication.';
COMMENT ON COLUMN edge_message_buffer.payload_encrypted IS
  'Encrypted C9 payload kept in the RF contour until drained to Communication Core.';

CREATE UNIQUE INDEX edge_message_buffer_idempotency_key_unique
  ON edge_message_buffer (idempotency_key);
CREATE UNIQUE INDEX edge_message_buffer_endpoint_sequence_unique
  ON edge_message_buffer (endpoint_id, sequence_number);
CREATE INDEX edge_message_buffer_pending_drain_idx
  ON edge_message_buffer (endpoint_id, sequence_number, received_at)
  WHERE forwarded_at IS NULL;
CREATE INDEX edge_message_buffer_ttl_idx
  ON edge_message_buffer (ttl)
  WHERE forwarded_at IS NULL;

-- down migration

DROP TABLE IF EXISTS edge_message_buffer;
