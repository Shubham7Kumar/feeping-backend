const AppError = require("../../shared/errors/AppError");

class ConsentService {
  constructor(
    consentRepository,
    studentRepository,
    auditRepository,
    transactionManager,
  ) {
    this.consentRepository = consentRepository;
    this.studentRepository = studentRepository;
    this.auditRepository = auditRepository;
    this.transactionManager = transactionManager;
  }

  async recordConsent(data, user) {
    const { studentId, purpose, action, source, evidenceReference } = data;

    // 1. Authentication and tenant context
    if (!user?.id || !user?.organizationId) {
      throw new AppError("Authentication required", 401, "AUTHENTICATION_REQUIRED");
    }

    // 2. Validate purpose
    if (!["receipt", "reminder"].includes(purpose)) {
      throw new AppError(
        "Invalid consent purpose",
        400,
        "INVALID_CONSENT_PURPOSE",
      );
    }

    // 3. Validate action
    if (!["granted", "revoked"].includes(action)) {
      throw new AppError(
        "Invalid consent action",
        400,
        "INVALID_CONSENT_ACTION",
      );
    }

    // 4. Validate source
    const normalizedSource = source?.trim();

    if (
      typeof normalizedSource !== "string" ||
      normalizedSource.length === 0 ||
      normalizedSource.length > 50
    ) {
      throw new AppError(
        "Consent source must contain 1–50 characters",
        400,
        "INVALID_CONSENT_SOURCE",
      );
    }

    // 5. Validate optional evidence reference
    if (
      evidenceReference !== undefined &&
      evidenceReference !== null &&
      typeof evidenceReference !== "string"
    ) {
      throw new AppError(
        "Evidence reference must be a string",
        400,
        "INVALID_EVIDENCE_REFERENCE",
      );
    }

    const normalizedEvidence = evidenceReference?.trim() || null;

    return this.transactionManager.execute(async (client) => {
      // Locking the student serializes consent changes for this student.
      const student = await this.studentRepository.findByIdForUpdate(
        studentId,
        user.organizationId,
        client,
      );

      if (!student) {
        throw new AppError("Student not found", 404, "STUDENT_NOT_FOUND");
      }

      // 6. Append a new consent event
      const consent = await this.consentRepository.create(
        {
          organizationId: user.organizationId,
          studentId,
          purpose,
          action,
          source: normalizedSource,
          evidenceReference: normalizedEvidence,
          recordedBy: user.id,
        },
        client,
      );

      // 7. Record the audit event in the same transaction
      await this.auditRepository.create(
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: `whatsapp.consent.${action}`,
          entityType: "whatsapp_consent",
          entityId: consent.id,
          details: {
            studentId,
            purpose,
            action,
            source: normalizedSource,
          },
        },
        client,
      );

      return consent;
    });
  }

  async getStudentConsents(studentId, user) {
    if (!user?.id || !user?.organizationId) {
      throw new AppError("Authentication required", 401, "AUTHENTICATION_REQUIRED");
    }

    const student = await this.studentRepository.findById(
      studentId,
      user.organizationId,
    );

    if (!student) {
      throw new AppError("Student not found", 404, "STUDENT_NOT_FOUND");
    }

    const consents = await this.consentRepository.findLatestForStudent(
      user.organizationId,
      studentId,
    );

    return {
      receipt: consents.find((consent) => consent.purpose === "receipt") || null,
      reminder: consents.find((consent) => consent.purpose === "reminder") || null,
    };
  }
}

module.exports = ConsentService;