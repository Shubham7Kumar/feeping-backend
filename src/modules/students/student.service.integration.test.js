require("dotenv").config();

const { randomUUID } = require("crypto");

const createPool = require("../../infrastructure/database/createPool");
const StudentRepository = require("./student.repository");
const StudentService = require("./student.service");
const TransactionManager = require("../../infrastructure/database/TransactionManager");
describe("StudentService PostgreSQL integration", () => {
  let pool;
  let studentRepository;
  let studentService;

  let organizationId;
  let otherOrganizationId;

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });

    studentRepository = new StudentRepository(pool);

    const transactionManager = new TransactionManager(pool);

    studentService = new StudentService(studentRepository, transactionManager);
  });

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
     VALUES ($1)
     RETURNING id`,
      [`Student Test ${randomUUID()}`],
    );

    organizationId = organization.rows[0].id;

    const otherOrganization = await pool.query(
      `INSERT INTO organizations (name)
     VALUES ($1)
     RETURNING id`,
      [`Other Student Test ${randomUUID()}`],
    );

    otherOrganizationId = otherOrganization.rows[0].id;
  });

  afterEach(async () => {
    if (organizationId) {
      await pool.query(`DELETE FROM students WHERE organization_id = $1`, [
        organizationId,
      ]);

      await pool.query(`DELETE FROM organizations WHERE id = $1`, [
        organizationId,
      ]);

      organizationId = null;
    }

    if (otherOrganizationId) {
      await pool.query(`DELETE FROM students WHERE organization_id = $1`, [
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

  async function createStudent(name, admissionNumber, orgId = organizationId) {
    return studentRepository.create({
      organizationId: orgId,
      name: name || `Test Student ${randomUUID()}`,
      admissionNumber: admissionNumber || null,
    });
  }

  test("returns paginated students with correct metadata", async () => {
    await createStudent("Rahul Sharma", `ADM-${randomUUID()}`);
    await createStudent("Priya Singh", `ADM-${randomUUID()}`);
    await createStudent("Amit Kumar", `ADM-${randomUUID()}`);

    const result = await studentService.getStudents(organizationId, {
      page: 1,
      limit: 2,
    });

    expect(result.students).toHaveLength(2);

    expect(result.pagination).toEqual({
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
  });

  test("searches students by name or admission number", async () => {
    await createStudent("Rahul Sharma", "ADM-RAHUL");
    await createStudent("Priya Singh", "ADM-PRIYA");
    await createStudent("Amit Kumar", "ADM-AMIT");

    const nameResult = await studentService.getStudents(organizationId, {
      search: "rahul",
    });

    expect(nameResult.students).toHaveLength(1);
    expect(nameResult.students[0].name).toBe("Rahul Sharma");

    const admissionResult = await studentService.getStudents(organizationId, {
      search: "ADM-PRIYA",
    });

    expect(admissionResult.students).toHaveLength(1);
    expect(admissionResult.students[0].admission_number).toBe("ADM-PRIYA");
  });

  test("filters students by active and inactive status", async () => {
    const activeStudent = await createStudent("Active Student", "ADM-ACTIVE");

    const inactiveStudent = await createStudent(
      "Inactive Student",
      "ADM-INACTIVE",
    );

    await pool.query(
      `UPDATE students
       SET is_active = FALSE
       WHERE id = $1 AND organization_id = $2`,
      [inactiveStudent.id, organizationId],
    );

    const activeResult = await studentService.getStudents(organizationId, {
      status: "active",
    });

    const inactiveResult = await studentService.getStudents(organizationId, {
      status: "inactive",
    });

    expect(activeResult.students.map((student) => student.id)).toContain(
      activeStudent.id,
    );

    expect(activeResult.students).toHaveLength(1);

    expect(inactiveResult.students.map((student) => student.id)).toContain(
      inactiveStudent.id,
    );

    expect(inactiveResult.students).toHaveLength(1);
  });

  test("does not return students belonging to another organization", async () => {
    const otherOrganization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id`,
      [`Other Student Test ${randomUUID()}`],
    );

    otherOrganizationId = otherOrganization.rows[0].id;

    await createStudent("My Organization Student", "ADM-MINE");

    await studentRepository.create({
      organizationId: otherOrganizationId,
      name: "Other Organization Student",
      admissionNumber: "ADM-OTHER",
    });

    const result = await studentService.getStudents(organizationId);

    expect(result.students).toHaveLength(1);
    expect(result.students[0].name).toBe("My Organization Student");
    expect(result.students[0].organization_id).toBe(organizationId);
  });

  test("updates student details successfully", async () => {
    const student = await createStudent("Rahul Sharma", "ADM-OLD");

    const updated = await studentService.updateStudent(
      student.id,
      {
        name: "Rahul Kumar",
        admissionNumber: "ADM-NEW",
        parentName: "Amit Kumar",
        parentWhatsapp: "9876543210",
      },
      organizationId,
    );

    expect(updated.name).toBe("Rahul Kumar");
    expect(updated.admission_number).toBe("ADM-NEW");
    expect(updated.parent_name).toBe("Amit Kumar");
    expect(updated.parent_whatsapp).toBe("9876543210");
  });

  test("rejects updating a student from another organization", async () => {
    const otherOrganization = await pool.query(
      `INSERT INTO organizations (name)
     VALUES ($1)
     RETURNING id`,
      [`Other Organization ${randomUUID()}`],
    );

    otherOrganizationId = otherOrganization.rows[0].id;

    const student = await studentRepository.create({
      organizationId: otherOrganizationId,
      name: "Other Student",
      admissionNumber: "ADM-OTHER",
    });

    await expect(
      studentService.updateStudent(
        student.id,
        { name: "Changed Name" },
        organizationId,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STUDENT_NOT_FOUND",
    });
  });

  test("rejects duplicate admission numbers within the organization", async () => {
    const firstStudent = await createStudent("Rahul", "ADM-101");
    await createStudent("Priya", "ADM-102");

    await expect(
      studentService.updateStudent(
        firstStudent.id,
        { admissionNumber: "ADM-102" },
        organizationId,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ADMISSION_NUMBER_ALREADY_EXISTS",
    });
  });

  test("rejects updating a student that does not exist", async () => {
    await expect(
      studentService.updateStudent(
        randomUUID(),
        { name: "Unknown Student" },
        organizationId,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STUDENT_NOT_FOUND",
    });
  });

  test("deactivates an active student", async () => {
    const student = await createStudent("Test Student");

    const updated = await studentService.setStudentActiveStatus(
      student.id,
      false,
      organizationId,
    );

    expect(updated.is_active).toBe(false);
  });

  test("reactivates an inactive student", async () => {
    const student = await createStudent("Test Student");

    await studentService.setStudentActiveStatus(
      student.id,
      false,
      organizationId,
    );

    const updated = await studentService.setStudentActiveStatus(
      student.id,
      true,
      organizationId,
    );

    expect(updated.is_active).toBe(true);
  });

  test("rejects setting the same student status twice", async () => {
    const student = await createStudent("Test Student");

    await expect(
      studentService.setStudentActiveStatus(student.id, true, organizationId),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "STUDENT_STATUS_UNCHANGED",
    });
  });

  test("does not allow another organization to change student status", async () => {
    const student = await createStudent(
      "Other Organization Student",
      "OTHER-101",
      otherOrganizationId,
    );

    await expect(
      studentService.setStudentActiveStatus(student.id, false, organizationId),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "STUDENT_NOT_FOUND",
    });
  });
});
