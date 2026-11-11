const AppError = require("../../shared/errors/AppError");

class StudentService {
  constructor(studentRepository, transactionManager) {
    this.studentRepository = studentRepository;
    this.transactionManager = transactionManager;
  }

  async createStudent(data, organizationId) {
    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    const name = data.name?.trim();

    if (!name) {
      throw new AppError(
        "Student name is required",
        400,
        "STUDENT_NAME_REQUIRED",
      );
    }

    return this.studentRepository.create({
      ...data,
      name,
      organizationId,
    });
  }

  async getStudentById(id, organizationId) {
    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    const student = await this.studentRepository.findById(id, organizationId);

    if (!student) {
      throw new AppError("Student not found", 404, "STUDENT_NOT_FOUND");
    }

    return student;
  }

  async getStudents(organizationId, filters = {}) {
    console.log("OrganizationId", organizationId);
    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    return this.studentRepository.findAll(organizationId, filters);
  }

  async updateStudent(id, data, organizationId) {
    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    try {
      return await this.transactionManager.execute(async (client) => {
        const student = await this.studentRepository.findByIdForUpdate(
          id,
          organizationId,
          client,
        );

        if (!student) {
          throw new AppError("Student not found", 404, "STUDENT_NOT_FOUND");
        }

        return this.studentRepository.update(id, organizationId, data, client);
      });
    } catch (error) {
      if (
        error.code === "23505" &&
        error.constraint === "students_organization_id_admission_number_key"
      ) {
        throw new AppError(
          "Admission number already exists in this organization",
          409,
          "ADMISSION_NUMBER_ALREADY_EXISTS",
        );
      }

      throw error;
    }
  }

  async setStudentActiveStatus(id, isActive, organizationId) {
    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    if (typeof isActive !== "boolean") {
      throw new AppError(
        "isActive must be a boolean",
        400,
        "INVALID_STUDENT_STATUS",
      );
    }

    return this.transactionManager.execute(async (client) => {
      const student = await this.studentRepository.findByIdForUpdate(
        id,
        organizationId,
        client,
      );

      if (!student) {
        throw new AppError("Student not found", 404, "STUDENT_NOT_FOUND");
      }

      if (student.is_active === isActive) {
        throw new AppError(
          `Student is already ${isActive ? "active" : "inactive"}`,
          409,
          "STUDENT_STATUS_UNCHANGED",
        );
      }

      return this.studentRepository.setActiveStatus(
        id,
        organizationId,
        isActive,
        client,
      );
    });
  }
}

module.exports = StudentService;
