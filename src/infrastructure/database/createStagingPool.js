
const createPool = require("./createPool");

function getDatabaseIdentity(connectionString, label) {
  let parsed;

  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.pathname.slice(1)
  ) {
    throw new Error(`${label} must be a valid PostgreSQL database URL`);
  }

  return [
    parsed.hostname.toLowerCase(),
    parsed.port || "5432",
    decodeURIComponent(parsed.pathname.slice(1)),
  ].join("|");
}

function validateStagingDatabase() {
  const stagingUrl = process.env.STAGING_DATABASE_URL;

  if (!stagingUrl) {
    throw new Error("STAGING_DATABASE_URL is required");
  }

  const stagingIdentity = getDatabaseIdentity(
    stagingUrl,
    "STAGING_DATABASE_URL",
  );

  const protectedUrls = [
    ["production", process.env.DATABASE_URL],
    ["test", process.env.TEST_DATABASE_URL],
  ];

  for (const [label, connectionString] of protectedUrls) {
    if (!connectionString) continue;

    const protectedIdentity = getDatabaseIdentity(
      connectionString,
      label,
    );

    if (stagingIdentity === protectedIdentity) {
      throw new Error(
        `Unsafe staging database: it matches the ${label} database`,
      );
    }
  }

  return stagingUrl;
}

function createStagingPool(options = {}) {
  const stagingUrl = validateStagingDatabase();

  return createPool(stagingUrl, options);
}

createStagingPool.validate = validateStagingDatabase;

module.exports = createStagingPool;
