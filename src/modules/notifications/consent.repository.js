class ConsentRepository {
  constructor(pool) {
    this.pool = pool;
  }
  async create(consentData, client) {
    const {
      organizationId,
      studentId,
      purpose,
      action,
      source,
      evidenceReference,
      recordedBy,
    } = consentData;

    const query = `
      INSERT INTO whatsapp_consents (
        organization_id,
        student_id,
        purpose,
        action,
        source,
        evidence_reference,
        recorded_by,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
      RETURNING *
    `;

    const result = await client.query(query, [
      organizationId,
      studentId,
      purpose,
      action,
      source,
      evidenceReference ?? null,
      recordedBy,
    ]);

    return result.rows[0];
  }

  async findLatestConsent(
    organizationId,
    studentId,
    purpose,
    client = this.pool,
  ) {
    const query = `
    SELECT
      id,
      action,
      source,
      evidence_reference,
      created_at
    FROM whatsapp_consents
    WHERE organization_id = $1
      AND student_id = $2
      AND purpose = $3
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;

    const result = await client.query(query, [
      organizationId,
      studentId,
      purpose,
    ]);

    return result.rows[0] || null;
  }

  async findLatestForStudent(organizationId, studentId, client = this.pool) {
    const query = `
      SELECT DISTINCT ON (purpose)
        id,
        organization_id,
        student_id,
        purpose,
        action,
        source,
        evidence_reference,
        recorded_by,
        created_at
      FROM whatsapp_consents
      WHERE organization_id = $1
        AND student_id = $2
      ORDER BY purpose, created_at DESC, id DESC
    `;

    const result = await client.query(query, [organizationId, studentId]);

    return result.rows;
  }
}

module.exports = ConsentRepository;
