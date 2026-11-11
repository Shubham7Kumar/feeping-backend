class MessageRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async queueReceipt(
    { organizationId, studentId, invoiceId, paymentId, consentId },
    client,
  ) {
    const query = `
      INSERT INTO whatsapp_messages (
        organization_id,
        student_id,
        invoice_id,
        payment_id,
        consent_id,
        purpose,
        message_type,
        status,
        idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, 'receipt', 'receipt', 'queued', $6)
      ON CONFLICT (organization_id, idempotency_key)
      DO NOTHING
      RETURNING *
    `;

    const values = [
      organizationId,
      studentId,
      invoiceId,
      paymentId,
      consentId,
      `receipt:${paymentId}`,
    ];

    const result = await client.query(query, values);

    return result.rows[0] || null;
  }


async claimQueuedMessages({
  workerId,
  batchSize = 10,
  leaseSeconds = 60,
  maxAttempts = 5,
}) {
  if (
    typeof workerId !== "string" ||
    workerId.trim().length === 0 ||
    workerId.length > 100
  ) {
    throw new Error("A valid workerId is required");
  }

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("batchSize must be between 1 and 100");
  }

  if (
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 10 ||
    leaseSeconds > 900
  ) {
    throw new Error("leaseSeconds must be between 10 and 900");
  }

  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  ) {
    throw new Error("maxAttempts must be between 1 and 20");
  }

  const query = `
    WITH exhausted_messages AS (
      UPDATE whatsapp_messages
      SET
        status = 'failed',
        last_error = 'Maximum attempts reached after lease expiration',
        locked_by = NULL,
        locked_until = NULL,
        updated_at = clock_timestamp()
      WHERE
        attempt_count >= $4
        AND (
          status = 'queued'
          OR (
            status = 'processing'
            AND locked_until <= clock_timestamp()
          )
        )
      RETURNING id
    ),
    candidates AS (
      SELECT id
      FROM whatsapp_messages
      WHERE
        attempt_count < $4
        AND (
          (
            status = 'queued'
            AND next_attempt_at <= clock_timestamp()
          )
          OR
          (
            status = 'processing'
            AND locked_until <= clock_timestamp()
            AND next_attempt_at <= clock_timestamp()
          )
        )
      ORDER BY scheduled_at ASC, created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    UPDATE whatsapp_messages AS messages
    SET
      status = 'processing',
      locked_by = $1,
      locked_until = clock_timestamp() + ($3 * INTERVAL '1 second'),
      attempt_count = messages.attempt_count + 1,
      updated_at = clock_timestamp()
    FROM candidates
    WHERE messages.id = candidates.id
    RETURNING messages.*;
  `;

  const result = await this.pool.query(query, [
    workerId,
    batchSize,
    leaseSeconds,
    maxAttempts,
  ]);

  return result.rows;
}


  async markAsSent({ messageId, workerId, providerMessageId }) {
    if (
      typeof providerMessageId !== "string" ||
      providerMessageId.trim().length === 0
    ) {
      throw new Error("A valid providerMessageId is required");
    }

    const query = `
      UPDATE whatsapp_messages
      SET
        status = 'sent',
        provider_message_id = $3,
        sent_at = clock_timestamp(),
        locked_by = NULL,
        locked_until = NULL,
        last_error = NULL,
        updated_at = NOW()
      WHERE
        id = $1
        AND status = 'processing'
        AND locked_by = $2
        AND locked_until > NOW()
      RETURNING id
    `;

    const result = await this.pool.query(query, [
      messageId,
      workerId,
      providerMessageId.trim(),
    ]);

    return result.rowCount === 1;
  }

  async scheduleRetry({
    messageId,
    workerId,
    retryAt,
    errorMessage,
    maxAttempts = 5,
  }) {
    if (!(retryAt instanceof Date) || Number.isNaN(retryAt.getTime())) {
      throw new Error("A valid retryAt date is required");
    }

    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error("maxAttempts must be between 1 and 20");
    }

    const query = `
      UPDATE whatsapp_messages
      SET
        status = CASE
          WHEN attempt_count >= $5 THEN 'failed'
          ELSE 'queued'
        END,
        next_attempt_at = $3,
        last_error = $4,
        locked_by = NULL,
        locked_until = NULL,
        updated_at = NOW()
      WHERE
        id = $1
        AND status = 'processing'
        AND locked_by = $2
        AND locked_until > clock_timestamp()
      RETURNING id, status
    `;

    const result = await this.pool.query(query, [
      messageId,
      workerId,
      retryAt,
      String(errorMessage || "Temporary delivery failure").slice(0, 2000),
      maxAttempts,
    ]);

    return result.rows[0] || null;
  }

  async markAsFailed({ messageId, workerId, errorMessage }) {
    const query = `
      UPDATE whatsapp_messages
      SET
        status = 'failed',
        last_error = $3,
        locked_by = NULL,
        locked_until = NULL,
        updated_at = NOW()
      WHERE
        id = $1
        AND status = 'processing'
        AND locked_by = $2
        AND locked_until > clock_timestamp()
      RETURNING id
    `;

    const result = await this.pool.query(query, [
      messageId,
      workerId,
      String(errorMessage || "Permanent delivery failure").slice(0, 2000),
    ]);

    return result.rowCount === 1;
  }

  async cancelClaimedMessage({ messageId, workerId, reason }) {
    if (!reason || typeof reason !== "string") {
      throw new Error("Cancellation reason is required");
    }

    const query = `
      UPDATE whatsapp_messages
      SET
        status = 'cancelled',
        last_error = $3,
        locked_until = NULL,
        locked_by = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND status = 'processing'
        AND locked_by = $2
        AND locked_until > NOW()
      RETURNING id, status
    `;

    const result = await this.pool.query(query, [
      messageId,
      workerId,
      reason.slice(0, 2000),
    ]);

    return result.rows[0] || null;
  }

  async markDeliveryUnknown({ messageId, workerId, errorMessage }) {
    const query = `
    UPDATE whatsapp_messages
    SET
      status = 'delivery_unknown',
      last_error = $3,
      locked_by = NULL,
      locked_until = NULL,
      updated_at = NOW()
    WHERE
      id = $1
      AND status = 'processing'
      AND locked_by = $2
      AND locked_until > NOW()
    RETURNING id, status
  `;

    const result = await this.pool.query(query, [
      messageId,
      workerId,
      String(errorMessage || "Provider delivery outcome is unknown").slice(
        0,
        2000,
      ),
    ]);

    return result.rows[0] || null;
  }

  async renewLease({ messageId, workerId, leaseSeconds = 120 }) {
    if (!messageId) {
      throw new Error("messageId is required");
    }

    if (typeof workerId !== "string" || workerId.trim().length === 0) {
      throw new Error("A valid workerId is required");
    }

    if (
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 10 ||
      leaseSeconds > 900
    ) {
      throw new Error("leaseSeconds must be between 10 and 900");
    }

    const query = `
    UPDATE whatsapp_messages
    SET
      locked_until = clock_timestamp() + ($3 * INTERVAL '1 second'),
      updated_at = clock_timestamp()
    WHERE
      id = $1
      AND status = 'processing'
      AND locked_by = $2
      AND locked_until > clock_timestamp()
    RETURNING id, locked_until
  `;

    const result = await this.pool.query(query, [
      messageId,
      workerId,
      leaseSeconds,
    ]);

    return result.rows[0] || null;
  }

async recordProviderAcceptance({
  messageId,
  workerId,
  providerMessageId,
}) {
  if (!messageId) {
    throw new Error("messageId is required");
  }

  if (typeof workerId !== "string" || workerId.trim().length === 0) {
    throw new Error("A valid workerId is required");
  }

  if (
    typeof providerMessageId !== "string" ||
    providerMessageId.trim().length === 0
  ) {
    throw new Error("A valid providerMessageId is required");
  }

  const query = `
    UPDATE whatsapp_messages
    SET
      status = 'sent',
      provider_message_id = $2,
      sent_at = clock_timestamp(),
      locked_by = NULL,
      locked_until = NULL,
      last_error = NULL,
      updated_at = clock_timestamp()
    WHERE
      id = $1
      AND status = 'processing'
      AND locked_by = $3
      AND provider_message_id IS NULL
    RETURNING id
  `;

  const result = await this.pool.query(query, [
    messageId,
    providerMessageId.trim(),
    workerId,
  ]);

  return result.rowCount === 1;
}
}

module.exports = MessageRepository;
