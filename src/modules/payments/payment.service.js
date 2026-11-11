const AppError = require("../../shared/errors/AppError");

const {
  toCents,
  createRequestFingerprint,
  normalizeMoney,
} = require("./payment.utils");

class PaymentService {
  constructor(
    paymentRepository,
    auditRepository,
    consentRepository,
    studentRepository,
    transactionManager,
    messageRepository = paymentRepository,
  ) {
    this.paymentRepository = paymentRepository;
    this.auditRepository = auditRepository;
    this.consentRepository = consentRepository;
    this.studentRepository = studentRepository;
    this.transactionManager = transactionManager;
    this.messageRepository = messageRepository;
  }

  async recordPayment(data, user, idempotencyKey) {
    const { invoiceId, amount, paymentMethod } = data;

    if (!user?.organizationId || !user?.id) {
      throw new AppError(
        "Authentication required",
        401,
        "AUTHENTICATION_REQUIRED",
      );
    }

    if (!idempotencyKey) {
      throw new AppError(
        "Idempotency key is required",
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
      );
    }

    const normalizedAmount = normalizeMoney(amount);
    const receivedAt = data.receivedAt || new Date().toISOString();

    const requestFingerprint = createRequestFingerprint({
      invoiceId: invoiceId.toLowerCase(),
      amount: normalizedAmount,
      paymentMethod,
      receivedAt: data.receivedAt || null,
    });

    try {
      return await this.transactionManager.execute(async (client) => {
        // 1. Check whether this request was already processed.
        const existingPayment =
          await this.paymentRepository.findByIdempotencyKey(
            user.organizationId,
            idempotencyKey,
            client,
          );

        if (existingPayment) {
          this.verifyIdempotency(existingPayment, requestFingerprint);

          return {
            payment: existingPayment,
            alreadyProcessed: true,
          };
        }

        // 2. Lock the invoice.
        const invoice = await this.paymentRepository.lockInvoice(
          invoiceId,
          user.organizationId,
          client,
        );

        if (!invoice) {
          throw new AppError("Invoice not found", 404, "INVOICE_NOT_FOUND");
        }

        if (invoice.lifecycle_status !== "active") {
          throw new AppError(
            "Cannot record payment for a cancelled invoice",
            422,
            "INVOICE_NOT_ACTIVE",
          );
        }

        // 3. Recheck after acquiring the invoice lock.
        const duplicatePayment =
          await this.paymentRepository.findByIdempotencyKey(
            user.organizationId,
            idempotencyKey,
            client,
          );

        if (duplicatePayment) {
          this.verifyIdempotency(duplicatePayment, requestFingerprint);

          return {
            payment: duplicatePayment,
            alreadyProcessed: true,
          };
        }

        // 4. Check invoice lifecycle.
        if (invoice.lifecycle_status !== "active") {
          throw new AppError(
            "Cannot record payment for a cancelled invoice",
            422,
            "INVOICE_NOT_ACTIVE",
          );
        }

        // 5. Calculate outstanding balance exactly.
        const effectivePaid =
          await this.paymentRepository.getEffectivePaidAmount(
            invoiceId,
            user.organizationId,
            client,
          );

        const outstanding =
          toCents(invoice.amount_due) - toCents(effectivePaid);

        const requestedAmount = toCents(normalizedAmount);

        if (requestedAmount <= 0n) {
          throw new AppError(
            "Payment amount must be greater than zero",
            422,
            "INVALID_PAYMENT_AMOUNT",
          );
        }

        if (outstanding <= 0n || requestedAmount > outstanding) {
          throw new AppError(
            "Payment exceeds the outstanding balance",
            422,
            "PAYMENT_EXCEEDS_BALANCE",
          );
        }

        // 6. Generate receipt number.
        const receiptNumber =
          await this.paymentRepository.generateReceiptNumber(
            user.organizationId,
            client,
          );

        // 7. Insert payment.
        const payment = await this.paymentRepository.create(
          {
            organizationId: user.organizationId,
            invoiceId,
            receiptNumber,
            amount: normalizedAmount,
            paymentMethod,
            receivedAt,
            idempotencyKey,
            requestFingerprint,
            recordedBy: user.id,
          },
          client,
        );

        await this.auditRepository.create(
          {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: "payment.recorded",
            entityType: "payment",
            entityId: payment.id,
            details: {
              invoiceId,
              amount: normalizedAmount,
              paymentMethod,
              receiptNumber,
            },
          },
          client,
        );

        // Check parent contact details.
        const student = await this.studentRepository.findContactById(
          invoice.student_id,
          user.organizationId,
          client,
        );

        let receiptNotificationQueued = false;

        if (student?.parent_whatsapp) {
          // Check latest receipt consent.
          const consent = await this.consentRepository.findLatestConsent(
            user.organizationId,
            invoice.student_id,
            "receipt",
            client,
          );

          if (consent?.action === "granted") {
            const queuedMessage = await this.messageRepository.queueReceipt(
              {
                organizationId: user.organizationId,
                studentId: invoice.student_id,
                invoiceId,
                paymentId: payment.id,
                consentId: consent.id,
              },
              client,
            );

            receiptNotificationQueued = Boolean(queuedMessage);
          }
        }

        return {
          payment,
          alreadyProcessed: false,
          receiptNotificationQueued,
        };
      });
    } catch (error) {
      const isIdempotencyConflict =
        error.code === "23505" &&
        error.constraint === "payments_organization_id_idempotency_key_key";

      if (!isIdempotencyConflict) {
        throw error;
      }

      // TransactionManager has rolled back before execution reaches here.
      const existingPayment = await this.paymentRepository.findByIdempotencyKey(
        user.organizationId,
        idempotencyKey,
      );

      if (!existingPayment) {
        throw error;
      }

      this.verifyIdempotency(existingPayment, requestFingerprint);

      return {
        payment: existingPayment,
        alreadyProcessed: true,
      };
    }
  }

  verifyIdempotency(existingPayment, requestFingerprint) {
    if (existingPayment.request_fingerprint !== requestFingerprint) {
      throw new AppError(
        "Idempotency key was already used with different payment data",
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
      );
    }
  }
}

module.exports = PaymentService;
