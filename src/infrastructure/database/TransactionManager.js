
class TransactionManager {
  constructor(pool) {
    this.pool = pool;
  }

  async execute(callback) {
    let destroyClient = false;
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await callback(client);

      await client.query("COMMIT");

      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroyClient = true;
        console.error("Transaction rollback failed:", rollbackError);
      }

      throw error;
    } finally {
      client.release(destroyClient);
    }
  }
}

module.exports = TransactionManager;
