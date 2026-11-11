class PaymentRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findByIdempotencyKey(
    organizationId,
    idempotencyKey,
    client = this.pool,
  ) {
    const query = `
      SELECT
        id,
        organization_id,
        invoice_id,
        receipt_number,
        amount,
        payment_method,
        received_at,
        idempotency_key,
        request_fingerprint,
        recorded_by,
        created_at
      FROM payments
      WHERE organization_id = $1
        AND idempotency_key = $2
      LIMIT 1
    `;

    const result = await client.query(query, [organizationId, idempotencyKey]);

    return result.rows[0] || null;
  }

  async lockInvoice(invoiceId, organizationId, client) {
    const query = `
      SELECT
        id,
        organization_id,
        student_id,
        description,
        amount_due,
        due_date,
        lifecycle_status
      FROM fee_invoices
      WHERE id = $1
        AND organization_id = $2
      FOR UPDATE
    `;

    const result = await client.query(query, [invoiceId, organizationId]);

    return result.rows[0] || null;
  }

  async getEffectivePaidAmount(invoiceId, organizationId, client) {
    const query = `
    SELECT
      COALESCE((
        SELECT SUM(p.amount)
        FROM payments p
        WHERE p.invoice_id = i.id
          AND p.organization_id = i.organization_id
      ), 0)

      +

      COALESCE((
        SELECT SUM(pa.amount_delta)
        FROM payment_adjustments pa
        JOIN payments p
          ON p.id = pa.payment_id
         AND p.organization_id = pa.organization_id
        WHERE p.invoice_id = i.id
          AND p.organization_id = i.organization_id
      ), 0) AS effective_paid

    FROM fee_invoices i
    WHERE i.id = $1
      AND i.organization_id = $2
  `;

    const result = await client.query(query, [invoiceId, organizationId]);

    return result.rows[0]?.effective_paid ?? "0.00";
  }

  async generateReceiptNumber(organizationId, client) {
    const query = `
    INSERT INTO organization_receipt_counters (
      organization_id,
      last_number
    )
    VALUES ($1, 1)

    ON CONFLICT (organization_id)
    DO UPDATE SET
      last_number =
        organization_receipt_counters.last_number + 1,
      updated_at = NOW()

    RETURNING last_number
  `;

    const result = await client.query(query, [organizationId]);

    const number = result.rows[0].last_number;

    return `FP-${String(number).padStart(6, "0")}`;
  }

  async create(paymentData, client) {
    const {
      organizationId,
      invoiceId,
      receiptNumber,
      amount,
      paymentMethod,
      receivedAt,
      idempotencyKey,
      requestFingerprint,
      recordedBy,
    } = paymentData;

    const query = `
    INSERT INTO payments (
      organization_id,
      invoice_id,
      receipt_number,
      amount,
      payment_method,
      received_at,
      idempotency_key,
      request_fingerprint,
      recorded_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `;

    const values = [
      organizationId,
      invoiceId,
      receiptNumber,
      amount,
      paymentMethod,
      receivedAt,
      idempotencyKey,
      requestFingerprint,
      recordedBy,
    ];

    const result = await client.query(query, values);

    return result.rows[0];
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

  async findPaymentForInvoice(paymentId, invoiceId, organizationId, client) {
    const query = `
    SELECT
      id,
      organization_id,
      invoice_id,
      amount
    FROM payments
    WHERE id = $1
      AND invoice_id = $2
      AND organization_id = $3
    FOR UPDATE
  `;

    const result = await client.query(query, [
      paymentId,
      invoiceId,
      organizationId,
    ]);

    return result.rows[0] || null;
  }

  async getEffectivePaymentAmount(paymentId, organizationId, client) {
    const query = `
    SELECT
      p.amount + COALESCE(SUM(pa.amount_delta), 0) AS effective_amount
    FROM payments p
    LEFT JOIN payment_adjustments pa
      ON pa.payment_id = p.id
      AND pa.organization_id = p.organization_id
    WHERE p.id = $1
      AND p.organization_id = $2
    GROUP BY p.id, p.amount
  `;

    const result = await client.query(query, [paymentId, organizationId]);

    return result.rows[0]?.effective_amount ?? null;
  }

  async findReceiptDetails(paymentId, invoiceId, organizationId, client = this.pool) {
    const query = `
      SELECT
        p.id AS payment_id,
        p.organization_id,
        p.invoice_id,
        p.receipt_number,
        p.amount,
        p.payment_method,
        p.received_at,
        i.description AS invoice_description
      FROM payments p
      INNER JOIN fee_invoices i
        ON i.id = p.invoice_id
       AND i.organization_id = p.organization_id
      WHERE p.id = $1
        AND p.invoice_id = $2
        AND p.organization_id = $3
      LIMIT 1
    `;

    const result = await client.query(query, [
      paymentId,
      invoiceId,
      organizationId,
    ]);

    return result.rows[0] || null;
  }

}

module.exports = PaymentRepository;
