CREATE TABLE organization_receipt_counters (
    organization_id UUID PRIMARY KEY
        REFERENCES organizations(id),

    last_number BIGINT NOT NULL DEFAULT 0
        CHECK (last_number >= 0),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
