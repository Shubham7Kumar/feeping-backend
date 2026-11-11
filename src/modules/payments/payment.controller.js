
class PaymentController {
  constructor(paymentService) {
    this.paymentService = paymentService;
  }

  async create(req, res, next) {
    try {
      const result = await this.paymentService.recordPayment(
        req.validatedBody,
        req.user,
        req.get("Idempotency-Key")
      );

      return res.status(result.alreadyProcessed ? 200 : 201).json({
        success: true,
        message: result.alreadyProcessed
          ? "Payment already recorded"
          : "Payment recorded successfully",
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = PaymentController;
