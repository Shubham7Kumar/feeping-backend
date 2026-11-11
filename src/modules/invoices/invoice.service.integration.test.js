require("dotenv").config();

const { randomUUID } = require("crypto");

const createPool = require("../../infrastructure/database/createPool");
const TransactionManager = require("../../infrastructure/database/TransactionManager");

const InvoiceRepository = require("./invoice.repository");
const InvoiceService = require("./invoice.service");
const StudentRepository = require("../students/student.repository");
const { invoiceListQuerySchema } = require("./invoice.validation");

describe("InvoiceService PostgreSQL integration", () => {
  let pool;
  let invoiceRepository;
  let invoiceService;
  let studentRepository;

  let organizationId;
  let otherOrganizationId = null;
  let userId;
  let studentId;
  let invoiceId;

  const testUser = () => ({
    id: userId,
    organizationId,
  });

  const invoiceData = (overrides = {}) => ({
    studentId,
    description: "Integration Test Invoice",
    amountDue: "1250.00",
    dueDate: "2026-12-15",
    ...overrides,
  });

  async function createTestPayment() {
    return pool.query(
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
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
     RETURNING *`,
      [
        organizationId,
        invoiceId,
        `TEST-${randomUUID()}`,
        "500.00",
        "upi",
        randomUUID(),
        randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64),
        userId,
      ],
    );
  }

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });

    invoiceRepository = new InvoiceRepository(pool);
    studentRepository = new StudentRepository(pool);

    const transactionManager = new TransactionManager(pool);

    invoiceService = new InvoiceService(
      invoiceRepository,
      studentRepository,
      transactionManager,
    );
  });

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id`,
      [`Invoice Test ${randomUUID()}`],
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
        "Invoice Test Owner",
        `invoice-${randomUUID()}@test.local`,
        "test-password-hash",
        "owner",
      ],
    );

    userId = user.rows[0].id;

    const student = await studentRepository.create({
      organizationId,
      name: "Invoice Test Student",
      admissionNumber: `INV-${randomUUID()}`,
    });

    studentId = student.id;
  });

  afterEach(async () => {
    if (!organizationId) return;

    await pool.query(
      `DELETE FROM payment_adjustments
     WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(
      `DELETE FROM payments
     WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(
      `DELETE FROM fee_invoices
     WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(
      `DELETE FROM students
     WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(
      `DELETE FROM users
     WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(
      `DELETE FROM organizations
     WHERE id = $1`,
      [organizationId],
    );

    organizationId = null;

    if (otherOrganizationId) {
      await pool.query(`DELETE FROM fee_invoices WHERE organization_id = $1`, [
        otherOrganizationId,
      ]);

      await pool.query(`DELETE FROM students WHERE organization_id = $1`, [
        otherOrganizationId,
      ]);

      await pool.query(`DELETE FROM users WHERE organization_id = $1`, [
        otherOrganizationId,
      ]);

      await pool.query(`DELETE FROM organizations WHERE id = $1`, [
        otherOrganizationId,
      ]);

      otherOrganizationId = null;
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  test("creates an invoice for an active student", async () => {
    const result = await invoiceService.createInvoice(
      invoiceData(),
      testUser(),
    );

    expect(result.id).toBeDefined();
    expect(result.organization_id).toBe(organizationId);
    expect(result.student_id).toBe(studentId);
    expect(result.created_by).toBe(userId);
    expect(result.amount_due).toBe("1250.00");
    expect(result.description).toBe("Integration Test Invoice");
    expect(result.lifecycle_status).toBe("active");

    const databaseResult = await pool.query(
      `SELECT *
       FROM fee_invoices
       WHERE id = $1
         AND organization_id = $2`,
      [result.id, organizationId],
    );

    expect(databaseResult.rows).toHaveLength(1);
  });

  test("rejects invoice creation for an inactive student", async () => {
    await pool.query(
      `UPDATE students
       SET is_active = FALSE
       WHERE id = $1
         AND organization_id = $2`,
      [studentId, organizationId],
    );

    await expect(
      invoiceService.createInvoice(invoiceData(), testUser()),
    ).rejects.toMatchObject({
      statusCode: 422,
    });

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM fee_invoices
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].count).toBe(0);
  });

  test("rejects a student belonging to another organization", async () => {
    const otherOrganizationResult = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id`,
      [`Other Invoice Org ${randomUUID()}`],
    );

    const otherOrganizationId = otherOrganizationResult.rows[0].id;

    let otherStudentId;

    try {
      const otherStudent = await studentRepository.create({
        organizationId: otherOrganizationId,
        name: "Other Organization Student",
        admissionNumber: `OTHER-${randomUUID()}`,
      });

      otherStudentId = otherStudent.id;

      await expect(
        invoiceService.createInvoice(
          invoiceData({ studentId: otherStudentId }),
          testUser(),
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
      });

      const result = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM fee_invoices
         WHERE organization_id = $1`,
        [organizationId],
      );

      expect(result.rows[0].count).toBe(0);
    } finally {
      await pool.query("DELETE FROM students WHERE organization_id = $1", [
        otherOrganizationId,
      ]);

      await pool.query("DELETE FROM organizations WHERE id = $1", [
        otherOrganizationId,
      ]);
    }
  });

  test("rolls back invoice insertion when a later operation fails", async () => {
    const originalCreate = invoiceRepository.create.bind(invoiceRepository);

    invoiceRepository.create = async (...args) => {
      await originalCreate(...args);

      throw new Error("Simulated failure after invoice insertion");
    };

    try {
      await expect(
        invoiceService.createInvoice(invoiceData(), testUser()),
      ).rejects.toThrow("Simulated failure after invoice insertion");
    } finally {
      invoiceRepository.create = originalCreate;
    }

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM fee_invoices
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].count).toBe(0);
  });
  test("updates invoice description and due date", async () => {
    const invoice = await invoiceService.createInvoice(
      invoiceData(),
      testUser(),
    );

    const updated = await invoiceService.updateInvoice(
      invoice.id,
      {
        description: "Updated Tuition Fee",
        dueDate: "2027-01-15",
      },
      testUser(),
    );

    expect(updated.description).toBe("Updated Tuition Fee");
    expect(updated.due_date.toISOString().slice(0, 10)).toBe("2027-01-14");
    expect(updated.amount_due).toBe("1250.00");
  });

  test("updates invoice amount when no payment history exists", async () => {
    const invoice = await invoiceService.createInvoice(
      invoiceData(),
      testUser(),
    );

    const updated = await invoiceService.updateInvoice(
      invoice.id,
      { amountDue: "1500" },
      testUser(),
    );

    expect(updated.amount_due).toBe("1500.00");
  });

  test("rejects amount update when payment history exists", async () => {
    const invoice = await invoiceService.createInvoice(
      invoiceData(),
      testUser(),
    );

    invoiceId = invoice.id;
    await createTestPayment();

    await expect(
      invoiceService.updateInvoice(
        invoice.id,
        { amountDue: "1500.00" },
        testUser(),
      ),
    ).rejects.toMatchObject({
      code: "INVOICE_HAS_PAYMENT_HISTORY",
      statusCode: 409,
    });

    const result = await pool.query(
      `SELECT amount_due FROM fee_invoices WHERE id = $1`,
      [invoice.id],
    );

    expect(result.rows[0].amount_due).toBe("1250.00");
  });

  test("cancels an invoice even when payment history exists", async () => {
    const invoice = await invoiceService.createInvoice(
      invoiceData(),
      testUser(),
    );

    invoiceId = invoice.id;
    const payment = await createTestPayment();

    const cancelled = await invoiceService.cancelInvoice(
      invoice.id,
      testUser(),
    );

    expect(cancelled.lifecycle_status).toBe("cancelled");

    const paymentResult = await pool.query(
      `SELECT * FROM payments WHERE id = $1`,
      [payment.rows[0].id],
    );

    expect(paymentResult.rows).toHaveLength(1);
    expect(paymentResult.rows[0].amount).toBe("500.00");
  });

  test("rejects updating and cancelling an already cancelled invoice", async () => {
    const invoice = await invoiceService.createInvoice(
      invoiceData(),
      testUser(),
    );

    await invoiceService.cancelInvoice(invoice.id, testUser());

    await expect(
      invoiceService.updateInvoice(
        invoice.id,
        { description: "Changed after cancellation" },
        testUser(),
      ),
    ).rejects.toMatchObject({
      code: "INVOICE_ALREADY_CANCELLED",
      statusCode: 409,
    });

    await expect(
      invoiceService.cancelInvoice(invoice.id, testUser()),
    ).rejects.toMatchObject({
      code: "INVOICE_ALREADY_CANCELLED",
      statusCode: 409,
    });
  });

  test("returns paginated invoices with correct metadata", async () => {
    for (let i = 1; i <= 5; i++) {
      await invoiceService.createInvoice(
        invoiceData({ description: `Invoice ${i}` }),
        testUser(),
      );
    }

    const result = await invoiceService.getInvoices(organizationId, {
      page: 2,
      limit: 2,
    });

    expect(result.invoices).toHaveLength(2);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 5,
      totalPages: 3,
    });
  });
  test("filters invoices by lifecycle status", async () => {
    const first = await invoiceService.createInvoice(
      invoiceData({ description: "Active Invoice" }),
      testUser(),
    );

    const second = await invoiceService.createInvoice(
      invoiceData({ description: "Cancelled Invoice" }),
      testUser(),
    );

    await invoiceService.cancelInvoice(second.id, testUser());

    const result = await invoiceService.getInvoices(organizationId, {
      status: "active",
    });

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].id).toBe(first.id);
  });
  test("filters invoices by student", async () => {
    const first = await invoiceService.createInvoice(
      invoiceData({ description: "Student A Invoice" }),
      testUser(),
    );

    const otherStudent = await studentRepository.create({
      organizationId,
      name: "Second Test Student",
      admissionNumber: `INV-${randomUUID()}`,
    });

    await invoiceService.createInvoice(
      invoiceData({
        studentId: otherStudent.id,
        description: "Student B Invoice",
      }),
      testUser(),
    );

    const result = await invoiceService.getInvoices(organizationId, {
      studentId,
    });

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].id).toBe(first.id);
  });
  test("filters invoices by due-date range", async () => {
    await invoiceService.createInvoice(
      invoiceData({ dueDate: "2026-11-05" }),
      testUser(),
    );

    const expected = await invoiceService.createInvoice(
      invoiceData({ dueDate: "2026-11-15" }),
      testUser(),
    );

    await invoiceService.createInvoice(
      invoiceData({ dueDate: "2026-12-05" }),
      testUser(),
    );

    const result = await invoiceService.getInvoices(organizationId, {
      dueFrom: "2026-11-10",
      dueTo: "2026-11-30",
    });

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].id).toBe(expected.id);
  });
  test("does not return invoices belonging to another organization", async () => {
    const ownInvoice = await invoiceService.createInvoice(
      invoiceData(),
      testUser(),
    );

    // Create another organization.
    const otherOrganization = await pool.query(
      `INSERT INTO organizations (name)
     VALUES ($1)
     RETURNING id`,
      [`Other Invoice Test ${randomUUID()}`],
    );

    otherOrganizationId = otherOrganization.rows[0].id;

    // Create its owner.
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
        "Other Test Owner",
        `other-${randomUUID()}@test.local`,
        "test-password-hash",
        "owner",
      ],
    );

    const otherUser = {
      id: otherUserResult.rows[0].id,
      organizationId: otherOrganizationId,
    };

    // Create its student.
    const otherStudent = await studentRepository.create({
      organizationId: otherOrganizationId,
      name: "Other Test Student",
      admissionNumber: `OTHER-${randomUUID()}`,
    });

    // Create an invoice belonging to the second organization.
    await invoiceService.createInvoice(
      invoiceData({
        studentId: otherStudent.id,
        description: "Another Organization Invoice",
      }),
      otherUser,
    );

    // Query using the first organization's ID.
    const result = await invoiceService.getInvoices(organizationId);

    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].id).toBe(ownInvoice.id);
  });

  describe("Invoice list query validation", () => {
    test("applies default pagination values", () => {
      const result = invoiceListQuerySchema.parse({});

      expect(result).toEqual({
        page: 1,
        limit: 20,
      });
    });

    test("rejects a page number below one", () => {
      const result = invoiceListQuerySchema.safeParse({
        page: "0",
      });

      expect(result.success).toBe(false);
    });

    test("rejects a limit above 100", () => {
      const result = invoiceListQuerySchema.safeParse({
        limit: "101",
      });

      expect(result.success).toBe(false);
    });

    test("rejects unknown query parameters", () => {
      const result = invoiceListQuerySchema.safeParse({
        unexpected: "value",
      });

      expect(result.success).toBe(false);
    });

    test("rejects an invalid due-date range", () => {
      const result = invoiceListQuerySchema.safeParse({
        dueFrom: "2026-12-20",
        dueTo: "2026-12-10",
      });

      expect(result.success).toBe(false);
    });
  });
});
