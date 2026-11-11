class AuditRepository {
  async create({
    organizationId,
    actorUserId,
    action,
    entityType,
    entityId,
    details
  }, client) {
    const query = `
      INSERT INTO audit_logs (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        details
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const values = [
      organizationId,
      actorUserId,
      action,
      entityType,
      entityId,
      details
    ];

    const result = await client.query(query, values);

    return result.rows[0];
  }
}

module.exports = AuditRepository;