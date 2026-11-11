const AppError = require("../../shared/errors/AppError");
const { toCents, fromCents } = require("./payment.utils");

class PaymentAdjustmentService {
  constructor(
    paymentRepository,
    adjustmentRepository,
    auditRepository,
    transactionManager,
  ) {
    this.paymentRepository = paymentRepository;
    this.adjustmentRepository = adjustmentRepository;
    this.auditRepository = auditRepository;
    this.transactionManager = transactionManager;
  }

  async applyAdjustment(data, user) {
    const {
      invoiceId,
      paymentId,
      amountDelta,
      adjustmentType,
      reason,
    } = data;

    if (!user?.organizationId || !user?.id) {
      throw new AppError(
        "Authentication required",
        401,
        "AUTHENTICATION_REQUIRED",
      );
    }

    if (!["correction", "reversal"].includes(adjustmentType)) {
      throw new AppError(
        "Invalid adjustment type",
        422,
        "INVALID_ADJUSTMENT_TYPE",
      );
    }

    if (typeof reason !== "string" || !reason.trim()) {
      throw new AppError(
        "Adjustment reason is required",
        422,
        "ADJUSTMENT_REASON_REQUIRED",
      );
    }

    let delta;

    try {
      delta = toCents(amountDelta);
    } catch {
      throw new AppError(
        "Invalid adjustment amount",
        422,
        "INVALID_ADJUSTMENT_AMOUNT",
      );
    }

    if (delta === 0n) {
      throw new AppError(
        "Adjustment amount cannot be zero",
        422,
        "INVALID_ADJUSTMENT_AMOUNT",
      );
    }

    if (adjustmentType === "reversal" && delta > 0n) {
      throw new AppError(
        "A reversal must reduce the payment amount",
        422,
        "INVALID_REVERSAL_AMOUNT",
      );
    }

    const normalizedDelta = fromCents(delta);

    return this.transactionManager.execute(async (client) => {
      // 1. Lock the invoice first.
      const invoice = await this.paymentRepository.lockInvoice(
        invoiceId,
        user.organizationId,
        client,
      );

      if (!invoice) {
        throw new AppError("Invoice not found", 404, "INVOICE_NOT_FOUND");
      }

      // 2. Find and lock the payment under this invoice.
      const payment = await this.paymentRepository.findPaymentForInvoice(
        paymentId,
        invoiceId,
        user.organizationId,
        client,
      );

      if (!payment) {
        throw new AppError(
          "Payment not found for this invoice",
          404,
          "PAYMENT_NOT_FOUND",
        );
      }

      // 3. Calculate the payment's current effective amount.
      const effectivePayment =
        await this.paymentRepository.getEffectivePaymentAmount(
          paymentId,
          user.organizationId,
          client,
        );

      const updatedPaymentAmount =
        toCents(effectivePayment) + delta;

      if (updatedPaymentAmount < 0n) {
        throw new AppError(
          "Adjustment cannot make the payment negative",
          422,
          "NEGATIVE_PAYMENT_BALANCE",
        );
      }

      // 4. Calculate the invoice's updated effective paid amount.
      const effectivePaid =
        await this.paymentRepository.getEffectivePaidAmount(
          invoiceId,
          user.organizationId,
          client,
        );

      const updatedInvoicePaid = toCents(effectivePaid) + delta;
      const invoiceAmount = toCents(invoice.amount_due);

      if (updatedInvoicePaid < 0n) {
        throw new AppError(
          "Adjustment cannot make the invoice paid amount negative",
          422,
          "NEGATIVE_INVOICE_BALANCE",
        );
      }

      if (updatedInvoicePaid > invoiceAmount) {
        throw new AppError(
          "Adjustment cannot exceed the invoice amount",
          422,
          "ADJUSTMENT_EXCEEDS_INVOICE",
        );
      }

      // 5. Insert an append-only adjustment record.
      const adjustment = await this.adjustmentRepository.create(
        {
          organizationId: user.organizationId,
          paymentId,
          amountDelta: normalizedDelta,
          adjustmentType,
          reason: reason.trim(),
          createdBy: user.id,
        },
        client,
      );

      // 6. Record the financial audit event in the same transaction.
      await this.auditRepository.create(
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: "payment.adjusted",
          entityType: "payment_adjustment",
          entityId: adjustment.id,
          details: {
            invoiceId,
            paymentId,
            amountDelta: normalizedDelta,
            adjustmentType,
            reason: reason.trim(),
          },
        },
        client,
      );

      return {
        adjustment,
        effectivePaymentAmount: fromCents(updatedPaymentAmount),
        effectiveInvoicePaid: fromCents(updatedInvoicePaid),
        outstandingAmount: fromCents(invoiceAmount - updatedInvoicePaid),
      };
    });
  }
}

module.exports = PaymentAdjustmentService;