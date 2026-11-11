
const container = require("./container");
const createMessageWorker = require("./modules/notifications/create-message-worker");

const worker = createMessageWorker(container);

const pollIntervalMs = 5000;


let isShuttingDown = false;
let shutdownResolve;

const shutdownRequested = new Promise((resolve) => {
  shutdownResolve = resolve;
});

function sleep(milliseconds) {
  return Promise.race([
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
    shutdownRequested,
  ]);
}
function waitForPollOrShutdown() {
  return sleep(pollIntervalMs);
}

function requestShutdown(signal) {
  if (isShuttingDown) return;

  isShuttingDown = true;
  console.log(
    `Received ${signal}. Stopping new batches and finishing current work...`,
  );

  shutdownResolve();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

async function run() {
  console.log(`FeePing Worker started: ${worker.workerId}`);

  try {
    while (!isShuttingDown) {
      try {
        const results = await worker.processBatch();

        if (results.claimed > 0) {
          console.log("Worker batch completed:", results);
        }

        if (results.claimed === 0 && !isShuttingDown) {
          await waitForPollOrShutdown();
        }
      } catch (error) {
        console.error("Worker batch error:", error.message);

        if (!isShuttingDown) {
          await waitForPollOrShutdown();
        }
      }
    }
  } finally {
    console.log("Closing worker database pool...");

    try {
      await container.pool.end();
      console.log("FeePing Worker stopped.");
    } catch (error) {
      console.error("Failed to close worker database pool:", error);
      process.exitCode = 1;
    }
  }
}

run().catch((error) => {
  console.error("Worker startup failed:", error);
  process.exitCode = 1;
});
