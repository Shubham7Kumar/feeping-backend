
const fs = require("fs");
const path = require("path");

const env = require("../src/config/env");
const createPool = require("../src/infrastructure/database/createPool");

const MIGRATIONS_DIR = path.join(__dirname, "../migrations");
const LOCK_KEY = 746501;

// Select the database explicitly.
function createMigrationPool(target) {
  if (target === "development") {
    console.log("Migration target: Neon development database");
    return createPool(env.DATABASE_URL);
  }

  if (target === "test") {
    if (!env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is not configured");
    }

    const testUrl = new URL(env.TEST_DATABASE_URL);

    // Fail closed: test migrations must only use our local Docker DB.
    const allowedHosts = ["localhost", "127.0.0.1", "::1"];

    if (
      !allowedHosts.includes(testUrl.hostname) ||
      testUrl.port !== "5433" ||
      testUrl.pathname !== "/feeping_test_db"
    ) {
      throw new Error(
        "Unsafe test database URL. Expected local feeping_test_db on port 5433."
      );
    }

    console.log("Migration target: Local Docker test database");

    return createPool(env.TEST_DATABASE_URL, {
      ssl: false,
    });
  }

  throw new Error(`Unknown migration target: ${target}`);
}

async function migrate() {
  const target = process.argv[2] || "development";

  let pool;
  let client;
  let lockAcquired = false;
  let destroyClient = false;

  try {
    pool = createMigrationPool(target);
    client = await pool.connect();

    // Prevent concurrent migration runners.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGSERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(file => file.endsWith(".sql"))
      .sort();

    const result = await client.query(
      "SELECT filename FROM schema_migrations"
    );

    const executed = new Set(
      result.rows.map(row => row.filename)
    );

    for (const filename of files) {
      if (executed.has(filename)) {
        console.log(`Skipping ${filename}`);
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(filePath, "utf8");

      console.log(`Running ${filename}`);

      await client.query("BEGIN");

      try {
        await client.query(sql);

        await client.query(
          `INSERT INTO schema_migrations (filename)
           VALUES ($1)`,
          [filename]
        );

        await client.query("COMMIT");

        console.log(`Completed ${filename}`);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          destroyClient = true;
          console.error("Rollback failed:", rollbackError.message);
        }

        throw error;
      }
    }

    console.log("Migrations completed.");

  } finally {
    if (client) {
      if (lockAcquired) {
        try {
          await client.query(
            "SELECT pg_advisory_unlock($1)",
            [LOCK_KEY]
          );
        } catch (error) {
          destroyClient = true;
          console.error("Advisory unlock failed:", error.message);
        }
      }

      client.release(destroyClient);
    }

    if (pool) {
      await pool.end();
    }
  }
}

migrate().catch(error => {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
});
