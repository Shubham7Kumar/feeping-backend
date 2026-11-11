const express = require("express");

const validate = require("../../shared/middleware/validate");
const {
  createStudentSchema,
  studentListQuerySchema,
  studentIdParamsSchema,
  updateStudentSchema,
  updateStudentStatusSchema,
} = require("./student.validation");
const authorize = require("../../shared/middleware/authorize");

function createStudentRoutes(studentController, authenticate) {
  const router = express.Router();

  router.post(
    "/",
    authenticate,
    authorize("owner", "admin"),
    validate(createStudentSchema),
    studentController.createStudent,
  );

  router.get(
    "/",
    authenticate,
    authorize("owner", "admin"),
    validate(studentListQuerySchema, "query"),
    studentController.getStudents,
  );

  router.get(
    "/:id",
    authenticate,
    authorize("owner", "admin"),
    validate(studentIdParamsSchema,"params"),
    studentController.getStudentById,
  );

  router.patch(
    "/:id",
    authenticate,
    authorize("owner", "admin"),
    validate(studentIdParamsSchema, "params"),
    validate(updateStudentSchema),
    studentController.updateStudent,
  );

  router.patch(
    "/:id/status",
    authenticate,
    authorize("owner", "admin"),
    validate(studentIdParamsSchema, "params"),
    validate(updateStudentStatusSchema),
    studentController.updateStudentStatus,
  );

  return router;
}

module.exports = createStudentRoutes;
