class StudentController {
  constructor(studentService) {
    this.studentService = studentService;

    this.createStudent = this.createStudent.bind(this);
    this.getStudentById = this.getStudentById.bind(this);
    this.getStudents = this.getStudents.bind(this);
    this.updateStudent = this.updateStudent.bind(this);
    this.updateStudentStatus = this.updateStudentStatus.bind(this);
  }

  async createStudent(req, res, next) {
    try {
      const organizationId = req.user?.organizationId;

      const student = await this.studentService.createStudent(
        req.validatedBody,
        organizationId,
      );

      return res.status(201).json({
        success: true,
        message: "Student created successfully",
        data: student,
      });
    } catch (error) {
      next(error);
    }
  }

  async getStudentById(req, res, next) {
    try {
      const organizationId = req.user?.organizationId;

      const student = await this.studentService.getStudentById(
        req.validatedParams.id,
        organizationId,
      );

      return res.status(200).json({
        success: true,
        data: student,
      });
    } catch (error) {
      next(error);
    }
  }

  async getStudents(req, res, next) {
    try {
      const organizationId = req.user?.organizationId;

      const students = await this.studentService.getStudents(
        organizationId,
        req.validatedQuery,
      );

      return res.status(200).json({
        success: true,
        count: students.length,
        data: students,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateStudent(req, res, next) {
    try {
      const organizationId = req.user?.organizationId;

      const student = await this.studentService.updateStudent(
        req.validatedParams.id,
        req.validatedBody,
        organizationId,
      );

      return res.status(200).json({
        success: true,
        message: "Student updated successfully",
        data: student,
      });
    } catch (error) {
      next(error);
    }
  }

  async updateStudentStatus(req, res, next) {
    try {
      const organizationId = req.user?.organizationId;

      const student = await this.studentService.setStudentActiveStatus(
        req.validatedParams.id,
        req.validatedBody.isActive,
        organizationId,
      );

      return res.status(200).json({
        success: true,
        message: `Student ${student.is_active ? "activated" : "deactivated"} successfully`,
        data: student,
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = StudentController;
