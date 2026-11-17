
require("dotenv").config();

const createStagingPool = require(
  "../src/infrastructure/database/createStagingPool"
);

const pool = createStagingPool({
    max: 1
  });

async function verify() {
  try {
    const result = await pool.query(
      `
        SELECT
          id,
          organization_id,
          payment_id,
          purpose,
          status,
          provider_message_id,
          attempt_count,
          sent_at,
          locked_by,
          locked_until
        FROM whatsapp_messages
        WHERE payment_id = $1
      `,
      ["58a560f9-53af-41c6-bf5f-0b8dd4fa5366"],
    );

    if (result.rows.length !== 1) {
      throw new Error(
        `Expected one receipt message, found ${result.rows.length}`,
      );
    }

    const message = result.rows[0];

    console.log("STAGING MESSAGE VERIFICATION");
    console.table([message]);

    if (
      message.status !== "sent" ||
      !message.provider_message_id ||
      Number(message.attempt_count) !== 1 ||
      message.locked_by !== null ||
      message.locked_until !== null
    ) {
      throw new Error("Receipt message verification failed");
    }

    console.log("RECEIPT MESSAGE VERIFIED");
  } finally {
    await pool.end();
  }
}

verify().catch((error) => {
  console.error("Verification failed:", error.message);
  process.exitCode = 1;
});
