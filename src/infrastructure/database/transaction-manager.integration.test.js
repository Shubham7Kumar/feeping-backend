require("dotenv").config();
const createPool = require("./createPool");
const TransactionManager = require("./TransactionManager");

describe("TransactionManager - PostgreSQL integration", () => {
  let pool;
  let transactionManager;

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });

    transactionManager = new TransactionManager(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  test("rolls back database changes when transaction fails", async () => {
    const filename = `integration-test-${Date.now()}.sql`;

    await expect(
      transactionManager.execute(async (client) => {
        await client.query(
          `INSERT INTO schema_migrations (filename)
           VALUES ($1)`,
          [filename],
        );

        throw new Error("Intentional transaction failure");
      }),
    ).rejects.toThrow("Intentional transaction failure");

    const result = await pool.query(
      `SELECT filename
       FROM schema_migrations
       WHERE filename = $1`,
      [filename],
    );

    expect(result.rows).toHaveLength(0);
  });

  test("commits database changes when transaction succeeds", async () => {
    const filename = `integration-commit-${Date.now()}.sql`;

    const result = await transactionManager.execute(async (client) => {
      await client.query(
        `INSERT INTO schema_migrations (filename)
       VALUES ($1)`,
        [filename],
      );

      return { saved: true };
    });

    expect(result).toEqual({ saved: true });

    const databaseResult = await pool.query(
      `SELECT filename
     FROM schema_migrations
     WHERE filename = $1`,
      [filename],
    );

    expect(databaseResult.rows).toHaveLength(1);

    // Cleanup committed test data.
    await pool.query("DELETE FROM schema_migrations WHERE filename = $1", [
      filename,
    ]);
  });
});
