class InvoiceRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create(invoiceData,client=this.pool) {
    const {
      organizationId,
      studentId,
      description,
      amountDue,
      dueDate,
      createdBy,
    } = invoiceData;

    const query = `
        INSERT INTO fee_invoices (
            organization_id,
            student_id,
            description,
            amount_due,
            due_date,
            created_by
        )
        VALUES($1, $2, $3, $4, $5, $6)
        RETURNING *
    `
    const values = [
        organizationId,
        studentId,
        description,
        amountDue,
        dueDate,
        createdBy
    ]

    const result = await client.query(query,values)
    return result.rows[0];
  }

async findAll(organizationId, filters = {}) {
  const {
    page = 1,
    limit = 20,
    status,
    studentId,
    dueFrom,
    dueTo,
  } = filters;

  const conditions = ["organization_id = $1"];
  const values = [organizationId];

  const addCondition = (sql, value) => {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length}`));
  };

  if (status) {
    addCondition("lifecycle_status = ?", status);
  }

  if (studentId) {
    addCondition("student_id = ?", studentId);
  }

  if (dueFrom) {
    addCondition("due_date >= ?::date", dueFrom);
  }

  if (dueTo) {
    addCondition("due_date <= ?::date", dueTo);
  }

  const whereClause = conditions.join(" AND ");

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM fee_invoices
    WHERE ${whereClause}
  `;

  const countResult = await this.pool.query(countQuery, values);
  const total = countResult.rows[0].total;

  const offset = (page - 1) * limit;

  const dataValues = [...values, limit, offset];

  const dataQuery = `
    SELECT *
    FROM fee_invoices
    WHERE ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const dataResult = await this.pool.query(dataQuery, dataValues);

  return {
    invoices: dataResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

  async findById(id, organizationId, client = this.pool) {
    const query = `
      SELECT *
      FROM fee_invoices
      WHERE id = $1 AND organization_id = $2
      LIMIT 1
    `;

    const result = await client.query(query, [id, organizationId]);
    return result.rows[0] || null;
  }

  // Locks the invoice until the transaction finishes.
  async findByIdForUpdate(id, organizationId, client) {
    const query = `
      SELECT *
      FROM fee_invoices
      WHERE id = $1 AND organization_id = $2
      FOR UPDATE
    `;

    const result = await client.query(query, [id, organizationId]);
    return result.rows[0] || null;
  }

  // Checks whether any original payment record exists.
  async hasPaymentHistory(invoiceId, organizationId, client) {
    const query = `
      SELECT EXISTS (
        SELECT 1
        FROM payments
        WHERE invoice_id = $1
          AND organization_id = $2
      ) AS has_payments
    `;

    const result = await client.query(query, [
      invoiceId,
      organizationId
    ]);

    return result.rows[0].has_payments;
  }

  async update(id, organizationId, fields, client) {
    const updates = [];
    const values = [];
    let position = 1;

    if (fields.description !== undefined) {
      updates.push(`description = $${position++}`);
      values.push(fields.description);
    }

    if (fields.amountDue !== undefined) {
      updates.push(`amount_due = $${position++}`);
      values.push(fields.amountDue);
    }

    if (fields.dueDate !== undefined) {
      updates.push(`due_date = $${position++}`);
      values.push(fields.dueDate);
    }

    updates.push("updated_at = NOW()");

    values.push(id, organizationId);

    const query = `
      UPDATE fee_invoices
      SET ${updates.join(", ")}
      WHERE id = $${position++}
        AND organization_id = $${position}
      RETURNING *
    `;

    const result = await client.query(query, values);
    return result.rows[0] || null;
  }

  async cancel(id, organizationId, client) {
    const query = `
      UPDATE fee_invoices
      SET lifecycle_status = 'cancelled',
          updated_at = NOW()
      WHERE id = $1
        AND organization_id = $2
      RETURNING *
    `;

    const result = await client.query(query, [id, organizationId]);
    return result.rows[0] || null;
  }

}

module.exports = InvoiceRepository