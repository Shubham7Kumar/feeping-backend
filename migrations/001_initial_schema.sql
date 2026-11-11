
-- FeePing initial database schema
-- Migration: 001_initial_schema.sql

-- 1. Organizations
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    timezone VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(120) NOT NULL,
    email VARCHAR(254) NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL
        CHECK (role IN ('owner', 'admin')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX users_email_lower_unique
    ON users (LOWER(email));

-- 3. Students
CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    admission_number VARCHAR(80),
    name VARCHAR(150) NOT NULL,
    parent_name VARCHAR(150),
    parent_whatsapp VARCHAR(20),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (id, organization_id),
    UNIQUE (organization_id, admission_number)
);

-- 4. Fee invoices
CREATE TABLE fee_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    student_id UUID NOT NULL,
    description VARCHAR(250) NOT NULL,
    amount_due NUMERIC(12,2) NOT NULL CHECK (amount_due > 0),
    due_date DATE NOT NULL,
    lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (lifecycle_status IN ('active', 'cancelled')),
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (id, organization_id),

    FOREIGN KEY (student_id, organization_id)
        REFERENCES students(id, organization_id),

    FOREIGN KEY (created_by, organization_id)
        REFERENCES users(id, organization_id)
);

CREATE INDEX invoices_org_due_date_idx
    ON fee_invoices (organization_id, due_date)
    WHERE lifecycle_status = 'active';

CREATE INDEX invoices_org_student_idx
    ON fee_invoices (organization_id, student_id, created_at DESC);

-- 5. Payments
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    invoice_id UUID NOT NULL,
    receipt_number VARCHAR(50) NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(20) NOT NULL
        CHECK (payment_method IN ('cash', 'upi', 'bank_transfer')),
    received_at TIMESTAMPTZ NOT NULL,
    idempotency_key VARCHAR(200) NOT NULL,
    request_fingerprint VARCHAR(64) NOT NULL,
    recorded_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (id, organization_id),
    UNIQUE (organization_id, receipt_number),
    UNIQUE (organization_id, idempotency_key),

    FOREIGN KEY (invoice_id, organization_id)
        REFERENCES fee_invoices(id, organization_id),

    FOREIGN KEY (recorded_by, organization_id)
        REFERENCES users(id, organization_id)
);

CREATE INDEX payments_org_invoice_idx
    ON payments (organization_id, invoice_id, created_at);

-- 6. Payment adjustments
CREATE TABLE payment_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    payment_id UUID NOT NULL,
    amount_delta NUMERIC(12,2) NOT NULL CHECK (amount_delta <> 0),
    adjustment_type VARCHAR(20) NOT NULL
        CHECK (adjustment_type IN ('correction', 'reversal')),
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) > 0),
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (payment_id, organization_id)
        REFERENCES payments(id, organization_id),

    FOREIGN KEY (created_by, organization_id)
        REFERENCES users(id, organization_id)
);

CREATE INDEX adjustments_org_payment_idx
    ON payment_adjustments (organization_id, payment_id);

-- 7. WhatsApp consent events
CREATE TABLE whatsapp_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    student_id UUID NOT NULL,
    purpose VARCHAR(20) NOT NULL
        CHECK (purpose IN ('receipt', 'reminder')),
    action VARCHAR(20) NOT NULL
        CHECK (action IN ('granted', 'revoked')),
    source VARCHAR(50) NOT NULL,
    evidence_reference TEXT,
    recorded_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (id, organization_id, student_id, purpose),

    FOREIGN KEY (student_id, organization_id)
        REFERENCES students(id, organization_id),

    FOREIGN KEY (recorded_by, organization_id)
        REFERENCES users(id, organization_id)
);

CREATE INDEX consents_org_student_purpose_idx
    ON whatsapp_consents (
        organization_id, student_id, purpose, created_at DESC
    );

-- 8. WhatsApp messages / transactional outbox
CREATE TABLE whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    student_id UUID NOT NULL,
    invoice_id UUID NOT NULL,
    payment_id UUID,
    consent_id UUID NOT NULL,
    purpose VARCHAR(20) NOT NULL
        CHECK (purpose IN ('receipt', 'reminder')),
    message_type VARCHAR(20) NOT NULL
        CHECK (message_type IN ('receipt', 'reminder')),
    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (
            status IN (
                'queued', 'processing', 'sent',
                'delivered', 'failed', 'cancelled'
            )
        ),
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    provider_message_id TEXT,
    idempotency_key VARCHAR(250) NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    locked_until TIMESTAMPTZ,
    locked_by VARCHAR(100),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (student_id, organization_id)
        REFERENCES students(id, organization_id),

    FOREIGN KEY (invoice_id, organization_id)
        REFERENCES fee_invoices(id, organization_id),

    FOREIGN KEY (payment_id, organization_id)
        REFERENCES payments(id, organization_id),

    FOREIGN KEY (
        consent_id, organization_id, student_id, purpose
    )
        REFERENCES whatsapp_consents(
            id, organization_id, student_id, purpose
        ),

    UNIQUE (organization_id, idempotency_key),

    CHECK (purpose = message_type),

    CHECK (
        (message_type = 'receipt' AND payment_id IS NOT NULL)
        OR
        (message_type = 'reminder' AND payment_id IS NULL)
    )
);

CREATE UNIQUE INDEX whatsapp_provider_message_unique
    ON whatsapp_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE INDEX whatsapp_queue_idx
    ON whatsapp_messages (next_attempt_at, scheduled_at)
    WHERE status = 'queued';

CREATE INDEX whatsapp_lease_idx
    ON whatsapp_messages (locked_until)
    WHERE status = 'processing';

-- 9. Audit logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    actor_user_id UUID,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(80) NOT NULL,
    entity_id UUID,
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (actor_user_id, organization_id)
        REFERENCES users(id, organization_id)
);

CREATE INDEX audit_org_created_idx
    ON audit_logs (organization_id, created_at DESC);

CREATE INDEX audit_entity_idx
    ON audit_logs (organization_id, entity_type, entity_id);

-- 10. Webhook events
CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(40) NOT NULL,
    provider_event_id VARCHAR(250) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    processing_status VARCHAR(20) NOT NULL DEFAULT 'received'
        CHECK (
            processing_status IN (
                'received', 'processing', 'processed', 'failed'
            )
        ),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    last_error TEXT,

    UNIQUE (provider, provider_event_id)
);

CREATE INDEX webhook_pending_idx
    ON webhook_events (received_at)
    WHERE processing_status IN ('received', 'failed');
