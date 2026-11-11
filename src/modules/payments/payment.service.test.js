const PaymentService = require("./payment.service");
const { createRequestFingerprint } = require("./payment.utils");

describe("PaymentService - recordPayment", () => {
  let service;
  let paymentRepository;
  let auditRepository;
  let consentRepository;
  let studentRepository;
  let transactionManager;

  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "owner",
  };

  const invoice = {
    id: "33333333-3333-4333-8333-333333333333",
    student_id: "44444444-4444-4444-8444-444444444444",
    amount_due: "10000.00",
    lifecycle_status: "active",
  };

  beforeEach(() => {
    paymentRepository = {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      lockInvoice: jest.fn().mockResolvedValue(invoice),
      getEffectivePaidAmount: jest.fn().mockResolvedValue("0.00"),
      generateReceiptNumber: jest.fn().mockResolvedValue("FP-000001"),
      create: jest.fn().mockResolvedValue({
        id: "55555555-5555-4555-8555-555555555555",
        amount: "500.00",
        receipt_number: "FP-000001",
      }),
      queueReceipt: jest.fn(),
    };

    auditRepository = {
      create: jest.fn().mockResolvedValue({}),
    };

    consentRepository = {
      findLatestConsent: jest.fn(),
    };

    studentRepository = {
      findContactById: jest.fn().mockResolvedValue(null),
    };

    transactionManager = {
      execute: jest.fn(async (callback) => callback({})),
    };

    service = new PaymentService(
      paymentRepository,
      auditRepository,
      consentRepository,
      studentRepository,
      transactionManager,
    );
  });

  test("records a valid payment successfully", async () => {
    const result = await service.recordPayment(
      {
        invoiceId: invoice.id,
        amount: "500.00",
        paymentMethod: "upi",
      },
      user,
      "PAY-TEST-001",
    );

    expect(result.alreadyProcessed).toBe(false);
    expect(result.payment.amount).toBe("500.00");

    expect(paymentRepository.create).toHaveBeenCalledTimes(1);
    expect(auditRepository.create).toHaveBeenCalledTimes(1);

    expect(result.receiptNotificationQueued).toBe(false);
  });
  test("returns the existing payment when the same request is retried", async () => {
    const fingerprint = createRequestFingerprint({
      invoiceId: invoice.id.toLowerCase(),
      amount: "500.00",
      paymentMethod: "upi",
      receivedAt: null,
    });

    const existingPayment = {
      id: "55555555-5555-4555-8555-555555555555",
      amount: "500.00",
      receipt_number: "FP-000001",
      request_fingerprint: fingerprint,
    };

    paymentRepository.findByIdempotencyKey.mockResolvedValueOnce(
      existingPayment,
    );

    const result = await service.recordPayment(
      {
        invoiceId: invoice.id,
        amount: "500.00",
        paymentMethod: "upi",
      },
      user,
      "PAY-TEST-001",
    );

    expect(result.alreadyProcessed).toBe(true);
    expect(result.payment.id).toBe(existingPayment.id);

    expect(paymentRepository.create).not.toHaveBeenCalled();
    expect(auditRepository.create).not.toHaveBeenCalled();
    expect(paymentRepository.lockInvoice).not.toHaveBeenCalled();
  });
  test("rejects payment greater than outstanding balance", async () => {
    await expect(
      service.recordPayment(
        {
          invoiceId: invoice.id,
          amount: "10001.00",
          paymentMethod: "upi",
        },
        user,
        "PAY-OVERPAY-001",
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "PAYMENT_EXCEEDS_BALANCE",
    });

    expect(paymentRepository.create).not.toHaveBeenCalled();
  });
  test("rejects the same idempotency key with a different request", async () => {
    const existingPayment = {
      id: "55555555-5555-4555-8555-555555555555",
      amount: "500.00",
      request_fingerprint: "existing-fingerprint",
    };

    paymentRepository.findByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingPayment);

    await expect(
      service.recordPayment(
        {
          invoiceId: invoice.id,
          amount: "700.00",
          paymentMethod: "upi",
        },
        user,
        "PAY-001",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });

    expect(paymentRepository.create).not.toHaveBeenCalled();
  });
  test("rejects payment for a cancelled invoice", async () => {
    paymentRepository.lockInvoice.mockResolvedValue({
      ...invoice,
      lifecycle_status: "cancelled",
    });

    await expect(
      service.recordPayment(
        {
          invoiceId: invoice.id,
          amount: "500.00",
          paymentMethod: "cash",
        },
        user,
        "PAY-CANCELLED-001",
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "INVOICE_NOT_ACTIVE",
    });

    expect(paymentRepository.create).not.toHaveBeenCalled();
  });
  test("queues a receipt when WhatsApp receipt consent is granted", async () => {
    studentRepository.findContactById.mockResolvedValue({
      id: invoice.student_id,
      parent_name: "Test Parent",
      parent_whatsapp: "919999999999",
    });

    consentRepository.findLatestConsent.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      action: "granted",
    });

    paymentRepository.queueReceipt.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      status: "queued",
    });

    const result = await service.recordPayment(
      {
        invoiceId: invoice.id,
        amount: "500.00",
        paymentMethod: "upi",
      },
      user,
      "PAY-RECEIPT-001",
    );

    expect(result.alreadyProcessed).toBe(false);
    expect(result.receiptNotificationQueued).toBe(true);

    expect(paymentRepository.queueReceipt).toHaveBeenCalledTimes(1);
  });
  test("does not queue a receipt when the latest consent is revoked", async () => {
    studentRepository.findContactById.mockResolvedValue({
      id: invoice.student_id,
      parent_name: "Test Parent",
      parent_whatsapp: "919999999999",
    });

    consentRepository.findLatestConsent.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      action: "revoked",
    });

    const result = await service.recordPayment(
      {
        invoiceId: invoice.id,
        amount: "500.00",
        paymentMethod: "upi",
      },
      user,
      "PAY-REVOKED-001",
    );

    expect(result.alreadyProcessed).toBe(false);
    expect(result.receiptNotificationQueued).toBe(false);

    expect(paymentRepository.queueReceipt).not.toHaveBeenCalled();
  });
});
