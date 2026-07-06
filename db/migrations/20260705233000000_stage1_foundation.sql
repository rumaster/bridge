-- up migration

ALTER TABLE channels
  ADD COLUMN credentials_envelope jsonb;

ALTER TABLE channels
  ADD CONSTRAINT channels_credentials_envelope_is_object CHECK (
    credentials_envelope IS NULL OR jsonb_typeof(credentials_envelope) = 'object'
  ),
  ADD CONSTRAINT channels_credentials_envelope_required_keys CHECK (
    credentials_envelope IS NULL OR (
      credentials_envelope ?& ARRAY['alg', 'kid', 'iv', 'tag', 'ciphertext', 'created_at']
      AND credentials_envelope->>'alg' = 'AES-256-GCM'
    )
  ),
  ADD CONSTRAINT channels_credentials_envelope_no_plaintext CHECK (
    credentials_envelope IS NULL OR NOT (
      credentials_envelope ?| ARRAY[
        'api_key',
        'access_key',
        'access_token',
        'password',
        'plaintext',
        'refresh_token',
        'secret',
        'token'
      ]
    )
  );

-- down migration

ALTER TABLE IF EXISTS channels
  DROP CONSTRAINT IF EXISTS channels_credentials_envelope_no_plaintext,
  DROP CONSTRAINT IF EXISTS channels_credentials_envelope_required_keys,
  DROP CONSTRAINT IF EXISTS channels_credentials_envelope_is_object,
  DROP COLUMN IF EXISTS credentials_envelope;
