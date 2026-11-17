
require("dotenv").config();

const createStagingPool = require(
  "../src/infrastructure/database/createStagingPool"
);

const pool = createStagingPool({
    max: 1
  });

const invoiceId = "00b61f59-608a-48bd-9eff-133c022e7511";
const organizationId = "18441889-9ad9-4851-819b-e71166d1d532";
const paymentId = "58a560f9-53af-41c6-bf5f-0b8dd4fa5366";

async function verify() {
  try {
    const result = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int
         FROM payments
         WHERE invoice_id = $1
           AND organization_id = $2) AS payment_count,

        (SELECT COUNT(*)::int
         FROM whatsapp_messages
         WHERE payment_id = $3
           AND organization_id = $2) AS receipt_message_count`,
      [invoiceId, organizationId, paymentId],
    );

    const counts = result.rows[0];

    console.log("STAGING IDEMPOTENCY VERIFICATION");
    console.table([counts]);

    if (
      counts.payment_count !== 1 ||
      counts.receipt_message_count !== 1
    ) {
      throw new Error("Duplicate or missing records detected");
    }

    console.log("IDEMPOTENCY DATABASE VERIFICATION: PASS");
  } finally {
    await pool.end();
  }
}

verify().catch((error) => {
  console.error("Verification failed:", error.message);
  process.exitCode = 1;
});
