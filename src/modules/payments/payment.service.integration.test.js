require("dotenv").config();

const { randomUUID } = require("crypto");

const createPool = require("../../infrastructure/database/createPool");
const TransactionManager = require("../../infrastructure/database/TransactionManager");

const PaymentRepository = require("./payment.repository");
const PaymentService = require("./payment.service");

const AuditRepository = require("../audit/audit.repository");
const ConsentRepository = require("../notifications/consent.repository");
const StudentRepository = require("../students/student.repository");

describe("PaymentService PostgreSQL integration", () => {
  let pool;
  let paymentService;

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
  });

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id`,
      [`Integration Test ${randomUUID()}`],
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
        "Integration Owner",
        `owner-${randomUUID()}@test.local`,
        "test-password-hash",
        "owner",
      ],
    );

    userId = user.rows[0].id;

    const studentRepository = new StudentRepository(pool);

    const student = await studentRepository.create({
      organizationId,
      name: "Test Student",
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
      [
        organizationId,
        studentId,
        "Integration Test Invoice",
        "1000.00",
        userId,
      ],
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
    if (pool) {
      await pool.end();
    }
  });

  test("records a payment, creates audit log and handles retry idempotently", async () => {
    const idempotencyKey = randomUUID();

    const paymentData = {
      invoiceId,
      amount: "700.00",
      paymentMethod: "upi",
      receivedAt: "2026-11-01T10:00:00.000Z",
    };

    // First request: actual PostgreSQL transaction.
    const firstResult = await paymentService.recordPayment(
      paymentData,
      testUser(),
      idempotencyKey,
    );

    expect(firstResult.alreadyProcessed).toBe(false);
    expect(firstResult.payment.amount).toBe("700.00");
    expect(firstResult.payment.receipt_number).toBe("FP-000001");
    expect(firstResult.receiptNotificationQueued).toBe(false);

    // Verify effective paid amount in PostgreSQL.
    const paymentRepository = new PaymentRepository(pool);

    const effectivePaid = await paymentRepository.getEffectivePaidAmount(
      invoiceId,
      organizationId,
      pool,
    );

    expect(effectivePaid).toBe("700.00");

    const outstanding = 1000 - Number(effectivePaid);

    expect(outstanding).toBe(300);

    // Verify audit log was committed.
    const auditResult = await pool.query(
      `SELECT action, entity_type, entity_id
       FROM audit_logs
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(auditResult.rows).toHaveLength(1);
    expect(auditResult.rows[0].action).toBe("payment.recorded");
    expect(auditResult.rows[0].entity_id).toBe(firstResult.payment.id);

    // Retry the same request with the same key.
    const retryResult = await paymentService.recordPayment(
      paymentData,
      testUser(),
      idempotencyKey,
    );

    expect(retryResult.alreadyProcessed).toBe(true);
    expect(retryResult.payment.id).toBe(firstResult.payment.id);

    // No duplicate payment.
    const paymentCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM payments
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(paymentCount.rows[0].count).toBe(1);

    // No duplicate audit log.
    const auditCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM audit_logs
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(auditCount.rows[0].count).toBe(1);
  });

  test("rolls back payment and receipt counter when audit logging fails", async () => {
    const idempotencyKey = randomUUID();

    const originalAuditRepository = paymentService.auditRepository;

    // Simulate a failure after payment insertion.
    paymentService.auditRepository = {
      async create() {
        throw new Error("Simulated audit database failure");
      },
    };

    try {
      await expect(
        paymentService.recordPayment(
          {
            invoiceId,
            amount: "700.00",
            paymentMethod: "upi",
            receivedAt: "2026-11-01T10:00:00.000Z",
          },
          testUser(),
          idempotencyKey,
        ),
      ).rejects.toThrow("Simulated audit database failure");
    } finally {
      // Restore the actual repository.
      paymentService.auditRepository = originalAuditRepository;
    }

    // Payment must not exist.
    const payments = await pool.query(
      `SELECT COUNT(*)::int AS count
     FROM payments
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(payments.rows[0].count).toBe(0);

    // Audit record must not exist.
    const audits = await pool.query(
      `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(audits.rows[0].count).toBe(0);

    // Receipt counter increment must also roll back.
    const counter = await pool.query(
      `SELECT last_number
     FROM organization_receipt_counters
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(counter.rows).toHaveLength(0);
  });

  test("prevents concurrent payments from exceeding invoice balance", async () => {
    const requests = [
      {
        amount: "700.00",
        idempotencyKey: randomUUID(),
      },
      {
        amount: "500.00",
        idempotencyKey: randomUUID(),
      },
    ];

    // Start both real payment transactions concurrently.
    const results = await Promise.allSettled(
      requests.map(({ amount, idempotencyKey }) =>
        paymentService.recordPayment(
          {
            invoiceId,
            amount,
            paymentMethod: "upi",
            receivedAt: "2026-11-01T10:00:00.000Z",
          },
          testUser(),
          idempotencyKey,
        ),
      ),
    );

    const successful = results.filter(
      (result) => result.status === "fulfilled",
    );

    const rejected = results.filter((result) => result.status === "rejected");

    // Exactly one request must succeed.
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The other request must fail because the balance is insufficient.
    expect(rejected[0].reason.code).toBe("PAYMENT_EXCEEDS_BALANCE");

    // Verify actual committed payments in PostgreSQL.
    const paymentResult = await pool.query(
      `SELECT
       COUNT(*)::int AS count,
       COALESCE(SUM(amount), 0)::numeric(12,2) AS total
     FROM payments
     WHERE organization_id = $1
       AND invoice_id = $2`,
      [organizationId, invoiceId],
    );

    expect(paymentResult.rows[0].count).toBe(1);

    const totalPaid = Number(paymentResult.rows[0].total);

    expect(totalPaid).toBeLessThanOrEqual(1000);

    const outstanding = 1000 - totalPaid;

    expect(outstanding).toBeGreaterThanOrEqual(0);

    // Exactly one audit record.
    const auditResult = await pool.query(
      `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(auditResult.rows[0].count).toBe(1);

    // Only one receipt number should have been consumed.
    const counterResult = await pool.query(
      `SELECT last_number
     FROM organization_receipt_counters
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(counterResult.rows[0].last_number).toBe("1");

    console.log({
      successfulAmount: totalPaid,
      outstanding,
      successfulRequests: successful.length,
      rejectedRequests: rejected.length,
    });
  });

  test("prevents one organization from paying another organization's invoice", async () => {
    // Create a second organization and its owner.
    const otherOrganizationResult = await pool.query(
      `INSERT INTO organizations (name)
     VALUES ($1)
     RETURNING id`,
      [`Other Organization ${randomUUID()}`],
    );

    const otherOrganizationId = otherOrganizationResult.rows[0].id;

    const otherUserResult = await pool.query(
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
        otherOrganizationId,
        "Other Owner",
        `other-${randomUUID()}@test.local`,
        "test-password-hash",
        "owner",
      ],
    );

    const otherUserId = otherUserResult.rows[0].id;

    try {
      await expect(
        paymentService.recordPayment(
          {
            invoiceId,
            amount: "500.00",
            paymentMethod: "upi",
          },
          {
            id: otherUserId,
            organizationId: otherOrganizationId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "INVOICE_NOT_FOUND",
      });

      // Organization A must have no payment.
      const paymentResult = await pool.query(
        `SELECT COUNT(*)::int AS count
       FROM payments
       WHERE organization_id = $1`,
        [organizationId],
      );

      expect(paymentResult.rows[0].count).toBe(0);

      // Organization A must have no audit record.
      const auditResult = await pool.query(
        `SELECT COUNT(*)::int AS count
       FROM audit_logs
       WHERE organization_id = $1`,
        [organizationId],
      );

      expect(auditResult.rows[0].count).toBe(0);

      // Organization A must have no receipt counter.
      const counterResult = await pool.query(
        `SELECT COUNT(*)::int AS count
       FROM organization_receipt_counters
       WHERE organization_id = $1`,
        [organizationId],
      );

      expect(counterResult.rows[0].count).toBe(0);
    } finally {
      await pool.query("DELETE FROM users WHERE organization_id = $1", [
        otherOrganizationId,
      ]);

      await pool.query("DELETE FROM organizations WHERE id = $1", [
        otherOrganizationId,
      ]);
    }
  });

  test("rejects payment exceeding invoice balance", async () => {
    await expect(
      paymentService.recordPayment(
        {
          invoiceId,
          amount: "1001.00",
          paymentMethod: "upi",
        },
        testUser(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "PAYMENT_EXCEEDS_BALANCE",
    });

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
     FROM payments
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].count).toBe(0);

    const auditResult = await pool.query(
      `SELECT COUNT(*)::int AS count
     FROM audit_logs
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(auditResult.rows[0].count).toBe(0);
  });

  test("rejects reuse of idempotency key with different payment data", async () => {
    const idempotencyKey = `payment-${randomUUID()}`;

    const firstResult = await paymentService.recordPayment(
      {
        invoiceId,
        amount: "500.00",
        paymentMethod: "upi",
      },
      testUser(),
      idempotencyKey,
    );

    expect(firstResult.alreadyProcessed).toBe(false);

    await expect(
      paymentService.recordPayment(
        {
          invoiceId,
          amount: "600.00",
          paymentMethod: "upi",
        },
        testUser(),
        idempotencyKey,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count,
            SUM(amount)::numeric(12,2) AS total
     FROM payments
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].count).toBe(1);
    expect(result.rows[0].total).toBe("500.00");
  });
});
