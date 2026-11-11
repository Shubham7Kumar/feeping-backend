const express = require("express");

const validate = require("../../shared/middleware/validate");
const authorize = require("../../shared/middleware/authorize");

const {
  recordConsentSchema,
  studentConsentParamsSchema,
} = require("./consent.validation");

function createConsentRoutes(consentController, authenticate) {
  const router = express.Router();

  // Record a grant/revoke event
  router.post(
    "/",
    authenticate,
    authorize("owner", "admin"),
    validate(recordConsentSchema),
    consentController.recordConsent,
  );

  // Read latest consent state for a student
  router.get(
    "/students/:studentId",
    authenticate,
    authorize("owner", "admin"),
    validate(studentConsentParamsSchema, "params"),
    consentController.getStudentConsents,
  );

  return router;
}

module.exports = createConsentRoutes;