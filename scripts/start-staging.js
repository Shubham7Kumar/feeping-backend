
require("dotenv").config();

const createStagingPool = require(
  "../src/infrastructure/database/createStagingPool"
);

const target = process.argv[2];

if (!["api", "worker"].includes(target)) {
  throw new Error("Usage: node scripts/start-staging.js api|worker");
}

// Validate staging URL against production and test DB identities.
// No database connection is opened by this validation.
createStagingPool.validate();

// Override before importing application modules.
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;

// Never send real WhatsApp messages from staging.
process.env.WHATSAPP_PROVIDER = "mock";

if (target === "api") {
  process.env.PORT = "5001";

  console.log("Starting FeePing STAGING API on port 5001...");
  require("../src/server");
} else {
  console.log("Starting FeePing STAGING Worker...");
  require("../src/worker");
}
