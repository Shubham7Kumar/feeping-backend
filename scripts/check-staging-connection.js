
require("dotenv").config();
const createStagingPool = require(
  "../src/infrastructure/database/createStagingPool"
);

async function checkStagingConnection() {
  const pool = createStagingPool({
    max: 1
  });

  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS db_user,
        version() AS server_version
    `);

    console.log("STAGING CONNECTION SUCCESS");
    console.log("Database:", result.rows[0].database);
    console.log("User:", result.rows[0].db_user);
    console.log(
      "PostgreSQL:",
      result.rows[0].server_version.split(" ").slice(0, 2).join(" ")
    );
  } finally {
    await pool.end();
  }
}

checkStagingConnection().catch((error) => {
  console.error("STAGING CONNECTION FAILED:", error.message);
  process.exitCode = 1;
});