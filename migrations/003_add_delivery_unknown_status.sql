
ALTER TABLE whatsapp_messages
DROP CONSTRAINT whatsapp_messages_status_check;

ALTER TABLE whatsapp_messages
ADD CONSTRAINT whatsapp_messages_status_check
CHECK (
    status IN (
        'queued',
        'processing',
        'sent',
        'delivered',
        'failed',
        'cancelled',
        'delivery_unknown'
    )
);
