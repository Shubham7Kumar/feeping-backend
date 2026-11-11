require("dotenv").config();

const { randomUUID } = require("crypto");

const createPool = require("../../infrastructure/database/createPool");
const TransactionManager = require("../../infrastructure/database/TransactionManager");

const StudentRepository = require("../students/student.repository");
const ConsentRepository = require("./consent.repository");
const AuditRepository = require("../audit/audit.repository");
const ConsentService = require("./consent.service");

describe("ConsentService PostgreSQL integration", () => {
  let pool;
  let studentRepository;
  let consentRepository;
  let auditRepository;
  let transactionManager;
  let consentService;

  let organizationId;
  let otherOrganizationId;
  let user;
  let otherUser;
  let student;
  let otherStudent;

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });

    studentRepository = new StudentRepository(pool);
    consentRepository = new ConsentRepository(pool);
    auditRepository = new AuditRepository(pool);
    transactionManager = new TransactionManager(pool);

    consentService = new ConsentService(
      consentRepository,
      studentRepository,
      auditRepository,
      transactionManager,
    );
  });

  async function createUser(orgId) {
    const result = await pool.query(
      `INSERT INTO users (
        organization_id,
        name,
        email,
        password_hash,
        role
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, organization_id, name, email, role`,
      [
        orgId,
        "Consent Test Owner",
        `owner-${randomUUID()}@test.com`,
        "test-password-hash",
        "owner",
      ],
    );

    const row = result.rows[0];

    // Match the authenticated user shape used by the application.
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      email: row.email,
      role: row.role,
    };
  }

  async function createStudent(orgId) {
    return studentRepository.create({
      organizationId: orgId,
      name: `Consent Student ${randomUUID()}`,
    });
  }

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1) RETURNING id`,
      [`Consent Test ${randomUUID()}`],
    );

    organizationId = organization.rows[0].id;

    const otherOrganization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1) RETURNING id`,
      [`Other Consent Test ${randomUUID()}`],
    );

    otherOrganizationId = otherOrganization.rows[0].id;

    user = await createUser(organizationId);
    otherUser = await createUser(otherOrganizationId);

    student = await createStudent(organizationId);
    otherStudent = await createStudent(otherOrganizationId);
  });

  afterEach(async () => {
    for (const orgId of [organizationId, otherOrganizationId]) {
      if (!orgId) continue;

      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [
        orgId,
      ]);

      await pool.query(
        `DELETE FROM whatsapp_consents WHERE organization_id = $1`,
        [orgId],
      );

      await pool.query(`DELETE FROM students WHERE organization_id = $1`, [
        orgId,
      ]);

      await pool.query(`DELETE FROM users WHERE organization_id = $1`, [orgId]);

      await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    }

    organizationId = null;
    otherOrganizationId = null;
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  test("records granted receipt consent and creates an audit log", async () => {
    const result = await consentService.recordConsent(
      {
        studentId: student.id,
        purpose: "receipt",
        action: "granted",
        source: "admin_recorded",
        evidenceReference: "parent-confirmation-001",
      },
      user,
    );

    expect(result.student_id).toBe(student.id);
    expect(result.organization_id).toBe(organizationId);
    expect(result.purpose).toBe("receipt");
    expect(result.action).toBe("granted");

    const audit = await pool.query(
      `SELECT * FROM audit_logs
       WHERE organization_id = $1
         AND entity_id = $2`,
      [organizationId, result.id],
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("whatsapp.consent.granted");
    expect(audit.rows[0].actor_user_id).toBe(user.id);
  });

  test("revokes consent without overwriting the previous event", async () => {
    await consentService.recordConsent(
      {
        studentId: student.id,
        purpose: "receipt",
        action: "granted",
        source: "admin_recorded",
      },
      user,
    );

    await consentService.recordConsent(
      {
        studentId: student.id,
        purpose: "receipt",
        action: "revoked",
        source: "parent_request",
      },
      user,
    );

    const history = await pool.query(
      `SELECT action
       FROM whatsapp_consents
       WHERE organization_id = $1
         AND student_id = $2
         AND purpose = 'receipt'
       ORDER BY created_at ASC, id ASC`,
      [organizationId, student.id],
    );

    expect(history.rows).toHaveLength(2);
    expect(history.rows.map((row) => row.action)).toEqual([
      "granted",
      "revoked",
    ]);

    const latest = await consentRepository.findLatestForStudent(
      organizationId,
      student.id,
    );

    expect(latest[0].action).toBe("revoked");
  });

  test("keeps receipt and reminder consent independent", async () => {
    await consentService.recordConsent(
      {
        studentId: student.id,
        purpose: "receipt",
        action: "granted",
        source: "admin_recorded",
      },
      user,
    );

    await consentService.recordConsent(
      {
        studentId: student.id,
        purpose: "reminder",
        action: "revoked",
        source: "parent_request",
      },
      user,
    );

    const result = await consentService.getStudentConsents(student.id, user);

    expect(result.receipt.action).toBe("granted");
    expect(result.reminder.action).toBe("revoked");
  });

  test("does not expose another organization's student", async () => {
    await expect(
      consentService.recordConsent(
        {
          studentId: otherStudent.id,
          purpose: "receipt",
          action: "granted",
          source: "admin_recorded",
        },
        user,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STUDENT_NOT_FOUND",
    });

    await expect(
      consentService.getStudentConsents(otherStudent.id, user),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STUDENT_NOT_FOUND",
    });
  });

  test("rolls back consent insertion when audit insertion fails", async () => {
    const failingAuditRepository = {
      async create() {
        throw new Error("Simulated audit failure");
      },
    };

    const failingConsentService = new ConsentService(
      consentRepository,
      studentRepository,
      failingAuditRepository,
      transactionManager,
    );

    await expect(
      failingConsentService.recordConsent(
        {
          studentId: student.id,
          purpose: "receipt",
          action: "granted",
          source: "admin_recorded",
        },
        user,
      ),
    ).rejects.toThrow("Simulated audit failure");

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM whatsapp_consents
       WHERE organization_id = $1
         AND student_id = $2`,
      [organizationId, student.id],
    );

    expect(result.rows[0].count).toBe(0);
  });

  test("returns null for consent purposes without recorded events", async () => {
    const result = await consentService.getStudentConsents(student.id, user);

    expect(result).toEqual({
      receipt: null,
      reminder: null,
    });
  });
});
