const { Pool } = require("pg");

function createPool(connectionString, options = {}) {
  if (
    typeof connectionString !== "string" ||
    connectionString.trim().length === 0
  ) {
    throw new Error("Database connection string is required");
  }

  const {
    ssl = true,
    max = 10,
  } = options;

  if (typeof ssl !== "boolean") {
    throw new Error("ssl must be a boolean");
  }

  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error("Pool max must be between 1 and 100");
  }

  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: ssl ? { rejectUnauthorized: true } : false,
  });

  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error:", error);
  });

  return pool;
}

module.exports = createPool;