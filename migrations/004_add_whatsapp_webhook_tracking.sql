
-- 1. Separate Meta delivery lifecycle from internal worker lifecycle.

ALTER TABLE whatsapp_messages
ADD COLUMN provider_status VARCHAR(20),
ADD COLUMN provider_status_at TIMESTAMPTZ,
ADD COLUMN provider_error_code VARCHAR(100),
ADD COLUMN provider_error_message TEXT;

ALTER TABLE whatsapp_messages
ADD CONSTRAINT whatsapp_messages_provider_status_check
CHECK (
    provider_status IS NULL
    OR provider_status IN (
        'sent',
        'delivered',
        'read',
        'failed'
    )
);

-- 2. Extend existing generic webhook event storage.

ALTER TABLE webhook_events
ADD COLUMN provider_message_id TEXT,
ADD COLUMN event_timestamp TIMESTAMPTZ;

-- 3. Efficient lookup of events by Meta message ID.

CREATE INDEX webhook_provider_message_idx
ON webhook_events (provider, provider_message_id)
WHERE provider_message_id IS NOT NULL;
