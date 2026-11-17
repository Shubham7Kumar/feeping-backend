
const createPool = require("./createPool");

function getDatabaseIdentity(connectionString, label) {
  let parsed;

  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use PostgreSQL`);
  }

  const database = decodeURIComponent(parsed.pathname.slice(1));

  if (!parsed.hostname || !database) {
    throw new Error(`${label} must include a host and database name`);
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";

  return `${host}|${port}|${database}`;
}

function createTestPool() {
  const testUrl = process.env.TEST_DATABASE_URL;

  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const testIdentity = getDatabaseIdentity(
    testUrl,
    "TEST_DATABASE_URL",
  );

  const parsedTestUrl = new URL(testUrl);
  const allowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
  ];

  if (
    !allowedHosts.includes(parsedTestUrl.hostname.toLowerCase()) ||
    parsedTestUrl.port !== "5433" ||
    parsedTestUrl.pathname !== "/feeping_test_db"
  ) {
    throw new Error(
      "Unsafe test database. Only local feeping_test_db on port 5433 is allowed.",
    );
  }

  const protectedUrls = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["STAGING_DATABASE_URL", process.env.STAGING_DATABASE_URL],
  ];

  for (const [label, connectionString] of protectedUrls) {
    if (!connectionString) continue;

    const protectedIdentity = getDatabaseIdentity(
      connectionString,
      label,
    );

    if (testIdentity === protectedIdentity) {
      throw new Error(
        `Unsafe configuration: TEST_DATABASE_URL matches ${label}`,
      );
    }
  }

  return createPool(testUrl, {
    ssl: false,
    max: 5,
  });
}

module.exports = createTestPool;
