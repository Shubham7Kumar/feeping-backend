class ConsentController {
  constructor(consentService) {
    this.consentService = consentService;

    this.recordConsent = this.recordConsent.bind(this);
    this.getStudentConsents = this.getStudentConsents.bind(this);
  }

  async recordConsent(req, res, next) {
    try {
      const consent = await this.consentService.recordConsent(
        req.validatedBody,
        req.user,
      );

      return res.status(201).json({
        success: true,
        message: "WhatsApp consent recorded successfully",
        data: consent,
      });
    } catch (error) {
      next(error);
    }
  }

  async getStudentConsents(req, res, next) {
    try {
      const consents = await this.consentService.getStudentConsents(
        req.validatedParams.studentId,
        req.user,
      );

      return res.status(200).json({
        success: true,
        data: consents,
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = ConsentController;