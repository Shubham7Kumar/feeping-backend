class PaymentAdjustmentRepository {
  async create(
    {
      organizationId,
      paymentId,
      amountDelta,
      adjustmentType,
      reason,
      createdBy,
    },
    client,
  ) {
    const query = `
      INSERT INTO payment_adjustments (
        organization_id,
        payment_id,
        amount_delta,
        adjustment_type,
        reason,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const values = [
      organizationId,
      paymentId,
      amountDelta,
      adjustmentType,
      reason,
      createdBy,
    ];

    const result = await client.query(query, values);

    return result.rows[0];
  }
}

module.exports = PaymentAdjustmentRepository;