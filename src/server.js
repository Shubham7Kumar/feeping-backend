const app = require("./app");
const env = require("./config/env");
const pool = require("./infrastructure/database/pool");

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`FeePing API running on port ${env.PORT}`);
});

async function shutdown() {
  console.log("Shutting down FeePing API...");

  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);