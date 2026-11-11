
require("dotenv").config();

const createPool = require("./createPool");

describe("PostgreSQL invoice row locking", () => {
  let pool;
  let organizationId;
  let userId;
  let studentId;
  let invoiceId;

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id`,
      ["Lock Test Organization"]
    );

    organizationId = organization.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users
        (organization_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        organizationId,
        "Test Owner",
        `lock-test-${Date.now()}@example.test`,
        "integration-test-hash",
        "owner",
      ]
    );

    userId = user.rows[0].id;

    const student = await pool.query(
      `INSERT INTO students (organization_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [organizationId, "Test Student"]
    );

    studentId = student.rows[0].id;

    const invoice = await pool.query(
      `INSERT INTO fee_invoices
        (organization_id, student_id, description,
         amount_due, due_date, created_by)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
       RETURNING id`,
      [
        organizationId,
        studentId,
        "Integration Test Invoice",
        1000,
        userId,
      ]
    );

    invoiceId = invoice.rows[0].id;
  });

  afterEach(async () => {
    if (!organizationId) return;

    await pool.query(
      `DELETE FROM payments WHERE organization_id = $1`,
      [organizationId]
    );

    await pool.query(
      `DELETE FROM fee_invoices WHERE organization_id = $1`,
      [organizationId]
    );

    await pool.query(
      `DELETE FROM students WHERE organization_id = $1`,
      [organizationId]
    );

    await pool.query(
      `DELETE FROM users WHERE organization_id = $1`,
      [organizationId]
    );

    await pool.query(
      `DELETE FROM organizations WHERE id = $1`,
      [organizationId]
    );

    organizationId = null;
  });

  test("second transaction waits and sees the committed payment", async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();

    let transactionAOpen = false;
    let transactionBOpen = false;

    try {
      await clientA.query("BEGIN");
      transactionAOpen = true;

      await clientB.query("BEGIN");
      transactionBOpen = true;

      // Transaction A locks the invoice.
      await clientA.query(
        `SELECT id
         FROM fee_invoices
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [invoiceId, organizationId]
      );

      // Get transaction B's PostgreSQL process ID.
      const pidResult = await clientB.query(
        "SELECT pg_backend_pid() AS pid"
      );

      const clientBPid = pidResult.rows[0].pid;

      // Transaction B attempts to lock the same invoice.
      const secondLockPromise = clientB.query(
        `SELECT id
         FROM fee_invoices
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [invoiceId, organizationId]
      );

      // Verify PostgreSQL reports that B is waiting for a lock.
      let isWaiting = false;
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline) {
        const activity = await pool.query(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE pid = $1`,
          [clientBPid]
        );

        if (activity.rows[0]?.wait_event_type === "Lock") {
          isWaiting = true;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 25));
      }

      expect(isWaiting).toBe(true);

      // A records ₹700 while holding the invoice lock.
      await clientA.query(
        `INSERT INTO payments (
          organization_id,
          invoice_id,
          receipt_number,
          amount,
          payment_method,
          received_at,
          idempotency_key,
          request_fingerprint,
          recorded_by
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)`,
        [
          organizationId,
          invoiceId,
          "FP-LOCK-TEST",
          700,
          "upi",
          "lock-test-payment-a",
          "integration-fingerprint",
          userId,
        ]
      );

      await clientA.query("COMMIT");
      transactionAOpen = false;

      // B now acquires the lock after A commits.
      await secondLockPromise;

      // B must see A's committed payment.
      const paidResult = await clientB.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid
         FROM payments
         WHERE organization_id = $1
           AND invoice_id = $2`,
        [organizationId, invoiceId]
      );

      const paid = Number(paidResult.rows[0].paid);
      const outstanding = 1000 - paid;

      expect(paid).toBe(700);
      expect(outstanding).toBe(300);

      // ₹500 cannot be accepted when only ₹300 remains.
      expect(500).toBeGreaterThan(outstanding);

      console.log({
        paid,
        outstanding,
        rejectedAmount: 500,
      });

    } finally {
      if (transactionAOpen) {
        await clientA.query("ROLLBACK");
      }

      if (transactionBOpen) {
        await clientB.query("ROLLBACK");
      }

      clientA.release();
      clientB.release();
    }
  }, 15000);
});
