class StudentRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create(studentData) {
    const {
      organizationId,
      name,
      admissionNumber,
      parentName,
      parentWhatsapp,
    } = studentData;

    const query = `
            INSERT INTO students (
                organization_id,
                name,
                admission_number,
                parent_name,
                parent_whatsapp
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;
    // $1, $2, $3	Parameterized query placeholders
    // RETURNING *	Return inserted/updated/deleted row

    const values = [
      organizationId,
      name,
      admissionNumber || null,
      parentName || null,
      parentWhatsapp || null,
    ];

    const result = await this.pool.query(query, values);

    return result.rows[0];

    /**
     * result.rows	    Returned database records
     * result.rows[0]	First returned record
     */
  }

  // async findById(id, organizationId) {
  //   const query = `
  //     SELECT *
  //     FROM students
  //     WHERE id = $1
  //       AND organization_id = $2
  //   `;

  //   const result = await this.pool.query(query, [id, organizationId]);

  //   return result.rows[0] || null;
  // }

  // One correction to our earlier repository example: a repository must support both normal queries and transaction-scoped queries.
  async findById(id, organizationId, client = this.pool) {
    const result = await client.query(
      `SELECT *
     FROM students
     WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );

    return result.rows[0] || null;
  }

  async findAll(organizationId, filters = {}) {
    const { page = 1, limit = 20, search, status } = filters;

    const conditions = ["organization_id = $1"];
    const values = [organizationId];

    const addCondition = (condition, value) => {
      values.push(value);
      conditions.push(condition.replace("?", `$${values.length}`));
    };

    // Search by student name or admission number.
    if (search) {
      values.push(`%${search}%`);
      const placeholder = `$${values.length}`;

      conditions.push(
        `(name ILIKE ${placeholder} OR admission_number ILIKE ${placeholder})`,
      );
    }

    // Convert API status into the database boolean.
    if (status) {
      addCondition("is_active = ?", status === "active");
    }

    const whereClause = conditions.join(" AND ");

    // First query: total matching records.
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total
     FROM students
     WHERE ${whereClause}`,
      values,
    );

    const total = countResult.rows[0].total;
    const offset = (page - 1) * limit;

    // Second query: paginated student records.
    const dataResult = await this.pool.query(
      `SELECT *
     FROM students
     WHERE ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length + 1}
     OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    return {
      students: dataResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findContactById(id, organizationId, client = this.pool) {
    const query = `
    SELECT
      id,
      organization_id,
      parent_name,
      parent_whatsapp
    FROM students
    WHERE id = $1
      AND organization_id = $2
    LIMIT 1
  `;

    const result = await client.query(query, [id, organizationId]);

    return result.rows[0] || null;
  }

  async findByIdForUpdate(id, organizationId, client) {
    const result = await client.query(
      `SELECT *
     FROM students
     WHERE id = $1
       AND organization_id = $2
     FOR UPDATE`,
      [id, organizationId],
    );

    return result.rows[0] || null;
  }

  async update(id, organizationId, data, client = this.pool) {
    const allowedFields = {
      name: "name",
      admissionNumber: "admission_number",
      parentName: "parent_name",
      parentWhatsapp: "parent_whatsapp",
    };

    const values = [];
    const assignments = [];

    for (const [field, column] of Object.entries(allowedFields)) {
      if (Object.hasOwn(data, field)) {
        values.push(data[field] || null);
        assignments.push(`${column} = $${values.length}`);
      }
    }

    if (assignments.length === 0) {
      return null;
    }

    values.push(new Date());
    assignments.push(`updated_at = $${values.length}`);

    values.push(id);
    const idPlaceholder = `$${values.length}`;

    values.push(organizationId);
    const organizationPlaceholder = `$${values.length}`;

    const result = await client.query(
      `UPDATE students
     SET ${assignments.join(", ")}
     WHERE id = ${idPlaceholder}
       AND organization_id = ${organizationPlaceholder}
     RETURNING *`,
      values,
    );

    return result.rows[0] || null;
  }

  async setActiveStatus(id, organizationId, isActive, client = this.pool) {
    const result = await client.query(
      `UPDATE students
     SET is_active = $1,
         updated_at = NOW()
     WHERE id = $2
       AND organization_id = $3
     RETURNING *`,
      [isActive, id, organizationId],
    );

    return result.rows[0] || null;
  }
}

module.exports = StudentRepository;
