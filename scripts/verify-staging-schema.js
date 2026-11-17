require("dotenv").config();
const createStagingPool = require("../src/infrastructure/database/createStagingPool");

async function verifyStagingSchema() {
  const pool = createStagingPool({
    max: 1,
  });

  try {
    const migrations = await pool.query(`
      SELECT filename
      FROM schema_migrations
      ORDER BY filename
    `);

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    console.log("STAGING SCHEMA VERIFICATION");
    console.log("Migrations applied:", migrations.rows.length);
    migrations.rows.forEach(({ filename }) => console.log(" -", filename));

    console.log("\nTables found:", tables.rows.length);
    tables.rows.forEach(({ table_name }) => console.log(" -", table_name));

    const requiredMigrations = [
      "001_initial_schema.sql",
      "002_receipt_counters.sql",
      "003_add_delivery_unknown_status.sql",
      "004_add_whatsapp_webhook_tracking.sql",
    ];

    const appliedMigrations = new Set(
      migrations.rows.map((row) => row.filename),
    );

    const missingMigrations = requiredMigrations.filter(
      (filename) => !appliedMigrations.has(filename),
    );

    if (missingMigrations.length > 0) {
      throw new Error(`Missing migrations: ${missingMigrations.join(", ")}`);
    }

    console.log("\nSTAGING SCHEMA VERIFIED");
  } finally {
    await pool.end();
  }
}

verifyStagingSchema().catch((error) => {
  console.error("Schema verification failed:", error.message);
  process.exitCode = 1;
});
