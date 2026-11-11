require("dotenv").config();

const { randomUUID } = require("crypto");

const createPool = require("../../infrastructure/database/createPool");
const TransactionManager = require("../../infrastructure/database/TransactionManager");

const PaymentRepository = require("./payment.repository");
const PaymentService = require("./payment.service");
const PaymentAdjustmentRepository = require("./payment-adjustment.repository");
const PaymentAdjustmentService = require("./payment-adjustment.service");

const AuditRepository = require("../audit/audit.repository");
const ConsentRepository = require("../notifications/consent.repository");
const StudentRepository = require("../students/student.repository");

describe("PaymentAdjustmentService PostgreSQL integration", () => {
  let pool;
  let paymentService;
  let adjustmentService;

  let organizationId;
  let userId;
  let studentId;
  let invoiceId;

  const testUser = () => ({
    id: userId,
    organizationId,
  });

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });

    const paymentRepository = new PaymentRepository(pool);
    const adjustmentRepository = new PaymentAdjustmentRepository();
    const auditRepository = new AuditRepository();
    const consentRepository = new ConsentRepository();
    const studentRepository = new StudentRepository(pool);
    const transactionManager = new TransactionManager(pool);

    paymentService = new PaymentService(
      paymentRepository,
      auditRepository,
      consentRepository,
      studentRepository,
      transactionManager,
    );

    adjustmentService = new PaymentAdjustmentService(
      paymentRepository,
      adjustmentRepository,
      auditRepository,
      transactionManager,
    );
  });

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id`,
      [`Adjustment Test ${randomUUID()}`],
    );

    organizationId = organization.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (
        organization_id,
        name,
        email,
        password_hash,
        role
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id`,
      [
        organizationId,
        "Adjustment Test Owner",
        `owner-${randomUUID()}@test.local`,
        "test-password-hash",
        "owner",
      ],
    );

    userId = user.rows[0].id;

    const studentRepository = new StudentRepository(pool);

    const student = await studentRepository.create({
      organizationId,
      name: "Adjustment Test Student",
      admissionNumber: `ADM-${randomUUID()}`,
    });

    studentId = student.id;

    const invoice = await pool.query(
      `INSERT INTO fee_invoices (
        organization_id,
        student_id,
        description,
        amount_due,
        due_date,
        created_by
      )
      VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
      RETURNING id`,
      [organizationId, studentId, "Adjustment Test Invoice", "1000.00", userId],
    );

    invoiceId = invoice.rows[0].id;
  });

  afterEach(async () => {
    if (!organizationId) return;

    await pool.query(
      "DELETE FROM whatsapp_messages WHERE organization_id = $1",
      [organizationId],
    );

    await pool.query("DELETE FROM audit_logs WHERE organization_id = $1", [
      organizationId,
    ]);

    // Adjustments reference payments, so delete them first.
    await pool.query(
      "DELETE FROM payment_adjustments WHERE organization_id = $1",
      [organizationId],
    );

    await pool.query("DELETE FROM payments WHERE organization_id = $1", [
      organizationId,
    ]);

    await pool.query("DELETE FROM fee_invoices WHERE organization_id = $1", [
      organizationId,
    ]);

    await pool.query("DELETE FROM students WHERE organization_id = $1", [
      organizationId,
    ]);

    await pool.query("DELETE FROM users WHERE organization_id = $1", [
      organizationId,
    ]);

    await pool.query(
      "DELETE FROM organization_receipt_counters WHERE organization_id = $1",
      [organizationId],
    );

    await pool.query("DELETE FROM organizations WHERE id = $1", [
      organizationId,
    ]);

    organizationId = null;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function recordTestPayment(amount = "700.00") {
    const result = await paymentService.recordPayment(
      {
        invoiceId,
        amount,
        paymentMethod: "upi",
        receivedAt: "2026-11-01T10:00:00.000Z",
      },
      testUser(),
      randomUUID(),
    );

    return result.payment;
  }

  test("applies a negative correction and calculates effective balances", async () => {
    const payment = await recordTestPayment("700.00");

    const result = await adjustmentService.applyAdjustment(
      {
        invoiceId,
        paymentId: payment.id,
        amountDelta: "-100.00",
        adjustmentType: "correction",
        reason: "Original payment was recorded incorrectly",
      },
      testUser(),
    );

    expect(result.effectivePaymentAmount).toBe("600.00");
    expect(result.effectiveInvoicePaid).toBe("600.00");
    expect(result.outstandingAmount).toBe("400.00");

    const databaseResult = await pool.query(
      `SELECT
        p.amount + COALESCE(SUM(pa.amount_delta), 0) AS effective_payment,
        (
          SELECT SUM(p2.amount) + COALESCE(SUM(pa2.amount_delta), 0)
          FROM payments p2
          LEFT JOIN payment_adjustments pa2
            ON pa2.payment_id = p2.id
           AND pa2.organization_id = p2.organization_id
          WHERE p2.invoice_id = $1
            AND p2.organization_id = $2
          GROUP BY p2.invoice_id
        ) AS effective_invoice_paid
      FROM payments p
      LEFT JOIN payment_adjustments pa
        ON pa.payment_id = p.id
       AND pa.organization_id = p.organization_id
      WHERE p.id = $3
        AND p.organization_id = $2
      GROUP BY p.id, p.amount`,
      [invoiceId, organizationId, payment.id],
    );

    expect(databaseResult.rows[0].effective_payment).toBe("600.00");
    expect(databaseResult.rows[0].effective_invoice_paid).toBe("600.00");

    const audit = await pool.query(
      `SELECT id
       FROM audit_logs
       WHERE organization_id = $1
         AND action = 'payment.adjusted'`,
      [organizationId],
    );

    expect(audit.rowCount).toBe(1);
  });

  test("rejects an adjustment that makes an individual payment negative", async () => {
    const payment = await recordTestPayment("700.00");

    await expect(
      adjustmentService.applyAdjustment(
        {
          invoiceId,
          paymentId: payment.id,
          amountDelta: "-800.00",
          adjustmentType: "correction",
          reason: "Invalid correction",
        },
        testUser(),
      ),
    ).rejects.toMatchObject({
      code: "NEGATIVE_PAYMENT_BALANCE",
    });

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM payment_adjustments
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].count).toBe(0);
  });

  test("rejects a positive correction that exceeds invoice amount", async () => {
    const payment = await recordTestPayment("700.00");

    await expect(
      adjustmentService.applyAdjustment(
        {
          invoiceId,
          paymentId: payment.id,
          amountDelta: "400.00",
          adjustmentType: "correction",
          reason: "Invalid upward correction",
        },
        testUser(),
      ),
    ).rejects.toMatchObject({
      code: "ADJUSTMENT_EXCEEDS_INVOICE",
    });

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM payment_adjustments
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].count).toBe(0);
  });

  test("allows a positive correction within invoice balance", async () => {
    const payment = await recordTestPayment("700.00");

    const result = await adjustmentService.applyAdjustment(
      {
        invoiceId,
        paymentId: payment.id,
        amountDelta: "100.00",
        adjustmentType: "correction",
        reason: "Original payment was under-recorded",
      },
      testUser(),
    );

    expect(result.effectivePaymentAmount).toBe("800.00");
    expect(result.effectiveInvoicePaid).toBe("800.00");
    expect(result.outstandingAmount).toBe("200.00");
  });

  test("serializes concurrent adjustments to prevent negative payment balance", async () => {
    const payment = await recordTestPayment("700.00");

    const adjustmentA = adjustmentService.applyAdjustment(
      {
        invoiceId,
        paymentId: payment.id,
        amountDelta: "-500.00",
        adjustmentType: "correction",
        reason: "Concurrent correction A",
      },
      testUser(),
    );

    const adjustmentB = adjustmentService.applyAdjustment(
      {
        invoiceId,
        paymentId: payment.id,
        amountDelta: "-500.00",
        adjustmentType: "correction",
        reason: "Concurrent correction B",
      },
      testUser(),
    );

    const results = await Promise.allSettled([adjustmentA, adjustmentB]);

    const successful = results.filter(
      (result) => result.status === "fulfilled",
    );

    const rejected = results.filter((result) => result.status === "rejected");

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(rejected[0].reason.code).toBe("NEGATIVE_PAYMENT_BALANCE");

    const databaseResult = await pool.query(
      `SELECT
       p.amount + COALESCE(SUM(pa.amount_delta), 0)
         AS effective_payment,
       COUNT(pa.id)::int AS adjustment_count
     FROM payments p
     LEFT JOIN payment_adjustments pa
       ON pa.payment_id = p.id
      AND pa.organization_id = p.organization_id
     WHERE p.id = $1
       AND p.organization_id = $2
     GROUP BY p.id, p.amount`,
      [payment.id, organizationId],
    );

    expect(databaseResult.rows[0].effective_payment).toBe("200.00");
    expect(databaseResult.rows[0].adjustment_count).toBe(1);

    const auditResult = await pool.query(
      `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE organization_id = $1
       AND action = 'payment.adjusted'`,
      [organizationId],
    );

    expect(auditResult.rows[0].count).toBe(1);
  });

  test("rolls back adjustment when audit logging fails", async () => {
    const payment = await recordTestPayment("700.00");

    const failingAuditRepository = {
      async create() {
        throw new Error("Simulated audit database failure");
      },
    };

    const failingAdjustmentService = new PaymentAdjustmentService(
      new PaymentRepository(pool),
      new PaymentAdjustmentRepository(),
      failingAuditRepository,
      new TransactionManager(pool),
    );

    await expect(
      failingAdjustmentService.applyAdjustment(
        {
          invoiceId,
          paymentId: payment.id,
          amountDelta: "-100.00",
          adjustmentType: "correction",
          reason: "Test transaction rollback",
        },
        testUser(),
      ),
    ).rejects.toThrow("Simulated audit database failure");

    const adjustmentResult = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM payment_adjustments
       WHERE organization_id = $1`,
      [organizationId],
    );

    const paidAmount = await pool.query(
      `SELECT
        COALESCE(SUM(p.amount), 0)
        + COALESCE((
          SELECT SUM(pa.amount_delta)
          FROM payment_adjustments pa
          JOIN payments p2
            ON p2.id = pa.payment_id
           AND p2.organization_id = pa.organization_id
          WHERE p2.invoice_id = $1
            AND p2.organization_id = $2
        ), 0) AS effective_paid
       FROM payments p
       WHERE p.invoice_id = $1
         AND p.organization_id = $2`,
      [invoiceId, organizationId],
    );

    expect(adjustmentResult.rows[0].count).toBe(0);
    expect(paidAmount.rows[0].effective_paid).toBe("700.00");
  });
});
