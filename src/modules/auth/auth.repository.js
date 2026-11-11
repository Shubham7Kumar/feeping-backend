class AuthRepository {
  async createOrganization(client, name) {
    const query = `
      INSERT INTO organizations (name)
      VALUES ($1)
      RETURNING id, name, timezone
    `;

    const result = await client.query(query, [name]);

    return result.rows[0];
  }

  async createUser(client, userData) {
    const {
      organizationId,
      name,
      email,
      passwordHash
    } = userData;

    const query = `
      INSERT INTO users (
        organization_id,
        name,
        email,
        password_hash,
        role,
        is_active
      )
      VALUES ($1, $2, LOWER($3), $4, $5, $6)
      RETURNING
        id,
        organization_id,
        name,
        email,
        role,
        is_active,
        created_at
    `;

    const values = [
      organizationId,
      name,
      email,
      passwordHash,
      "owner",
      true
    ];

    const result = await client.query(query, values);

    return result.rows[0];
  }

  async findUserByEmail(email) {
    const query = `
      SELECT
        id,
        organization_id,
        name,
        email,
        password_hash,
        role,
        is_active
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;

    const result = await this.pool.query(query, [email]);

    return result.rows[0] || null;
  }

  async findActiveUserById(id) {
  const result = await this.pool.query(
    `SELECT
       id,
       organization_id,
       name,
       email,
       role,
       is_active
     FROM users
     WHERE id = $1 AND is_active = TRUE
     LIMIT 1`,
    [id]
  );

  return result.rows[0] || null;
}

  constructor(pool) {
    this.pool = pool;
  }
}

module.exports = AuthRepository;