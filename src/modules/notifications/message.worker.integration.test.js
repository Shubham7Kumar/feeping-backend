require("dotenv").config();

const { randomUUID } = require("crypto");

const createPool = require("../../infrastructure/database/createPool");
const MessageRepository = require("./message.repository");
const ConsentRepository = require("./consent.repository");
const InvoiceRepository = require("../invoices/invoice.repository");
const StudentRepository = require("../students/student.repository");
const PaymentRepository = require("../payments/payment.repository");
const MessageWorker = require("./message.worker");
const MockWhatsAppProvider = require("./providers/mock-whatsapp.provider");

describe("MessageWorker PostgreSQL integration", () => {
  let pool;
  let messageRepository;
  let consentRepository;
  let invoiceRepository;
  let studentRepository;
  let paymentRepository;
  let worker;

  let organizationId;
  let userId;
  let studentId;
  let invoiceId;

  const workerId = "worker-integration-test";

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });

    messageRepository = new MessageRepository(pool);
    consentRepository = new ConsentRepository(pool);
    invoiceRepository = new InvoiceRepository(pool);
    studentRepository = new StudentRepository(pool);
    paymentRepository = new PaymentRepository(pool);

    worker = new MessageWorker({
      messageRepository,
      consentRepository,
      invoiceRepository,
      studentRepository,
      paymentRepository,
      whatsappProvider: new MockWhatsAppProvider(),
      workerId,
    });
  });

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1) RETURNING id`,
      [`Worker Test ${randomUUID()}`],
    );

    organizationId = organization.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (
        organization_id, name, email, password_hash, role
      )
      VALUES ($1, $2, $3, $4, 'owner')
      RETURNING id`,
      [
        organizationId,
        "Worker Test Owner",
        `worker-${randomUUID()}@test.com`,
        "test-password-hash",
      ],
    );

    userId = user.rows[0].id;

    const student = await pool.query(
      `INSERT INTO students (
        organization_id, name, parent_name, parent_whatsapp
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id`,
      [organizationId, "Worker Test Student", "Test Parent", "919876543210"],
    );

    studentId = student.rows[0].id;

    const invoice = await pool.query(
      `INSERT INTO fee_invoices (
        organization_id, student_id, description,
        amount_due, due_date, created_by
      )
      VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
      RETURNING id`,
      [organizationId, studentId, "Tuition Fee", 1000, userId],
    );

    invoiceId = invoice.rows[0].id;

    const payment = await pool.query(
      `INSERT INTO payments (
        organization_id, invoice_id, receipt_number,
        amount, payment_method, received_at,
        idempotency_key, request_fingerprint, recorded_by
      )
      VALUES ($1, $2, $3, 500, 'cash', NOW(), $4, $5, $6)
      RETURNING id`,
      [
        organizationId,
        invoiceId,
        `FP-${randomUUID()}`,
        randomUUID(),
        "worker-test-fingerprint",
        userId,
      ],
    );

    const consent = await pool.query(
      `INSERT INTO whatsapp_consents (
        organization_id, student_id, purpose,
        action, source, recorded_by
      )
      VALUES ($1, $2, 'receipt', 'granted', 'test', $3)
      RETURNING id`,
      [organizationId, studentId, userId],
    );

    await messageRepository.queueReceipt(
      {
        organizationId,
        studentId,
        invoiceId,
        paymentId: payment.rows[0].id,
        consentId: consent.rows[0].id,
      },
      pool,
    );
    // Reset provider state for every test.
    worker.whatsappProvider = new MockWhatsAppProvider();
  });

  afterEach(async () => {
    if (!organizationId) return;

    await pool.query(
      `DELETE FROM whatsapp_messages WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(
      `DELETE FROM whatsapp_consents WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(
      `DELETE FROM payment_adjustments WHERE organization_id = $1`,
      [organizationId],
    );

    await pool.query(`DELETE FROM payments WHERE organization_id = $1`, [
      organizationId,
    ]);

    await pool.query(`DELETE FROM fee_invoices WHERE organization_id = $1`, [
      organizationId,
    ]);

    await pool.query(`DELETE FROM students WHERE organization_id = $1`, [
      organizationId,
    ]);

    await pool.query(`DELETE FROM users WHERE organization_id = $1`, [
      organizationId,
    ]);

    await pool.query(`DELETE FROM organizations WHERE id = $1`, [
      organizationId,
    ]);

    organizationId = null;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  test("delivers a queued receipt using the mock provider", async () => {
    const results = await worker.processBatch();

    expect(results).toEqual({
      claimed: 1,
      sent: 1,
      cancelled: 0,
      retried: 0,
      failed: 0,
      deliveryUnknown: 0,
    });

    const saved = await pool.query(
      `SELECT status, provider_message_id, sent_at,
              locked_by, locked_until
       FROM whatsapp_messages
       WHERE organization_id = $1`,
      [organizationId],
    );

    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0].status).toBe("sent");
    expect(saved.rows[0].provider_message_id).toMatch(/^mock-/);
    expect(saved.rows[0].sent_at).not.toBeNull();
    expect(saved.rows[0].locked_by).toBeNull();
    expect(saved.rows[0].locked_until).toBeNull();
  });

  test("cancels a queued receipt when the latest consent is revoked", async () => {
    // Record a newer consent revocation.
    await pool.query(
      `INSERT INTO whatsapp_consents (
      organization_id,
      student_id,
      purpose,
      action,
      source,
      recorded_by
    )
    VALUES ($1, $2, 'receipt', 'revoked', 'test-revocation', $3)`,
      [organizationId, studentId, userId],
    );

    const results = await worker.processBatch();

    expect(results).toEqual({
      claimed: 1,
      sent: 0,
      cancelled: 1,
      retried: 0,
      failed: 0,
      deliveryUnknown: 0,
    });

    const saved = await pool.query(
      `SELECT status, locked_by, locked_until
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(saved.rows[0].status).toBe("cancelled");
    expect(saved.rows[0].locked_by).toBeNull();
    expect(saved.rows[0].locked_until).toBeNull();
  });

  test("cancels a queued receipt when its invoice is cancelled", async () => {
    // Cancel the invoice before the worker processes the message.
    await pool.query(
      `UPDATE fee_invoices
     SET lifecycle_status = 'cancelled'
     WHERE id = $1 AND organization_id = $2`,
      [invoiceId, organizationId],
    );

    const sendReceiptSpy = jest.spyOn(worker.whatsappProvider, "sendReceipt");

    const results = await worker.processBatch();

    expect(results).toEqual({
      claimed: 1,
      sent: 0,
      cancelled: 1,
      retried: 0,
      failed: 0,
      deliveryUnknown: 0,
    });

    expect(sendReceiptSpy).not.toHaveBeenCalled();

    const saved = await pool.query(
      `SELECT status, locked_by, locked_until
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(saved.rows[0].status).toBe("cancelled");
    expect(saved.rows[0].locked_by).toBeNull();
    expect(saved.rows[0].locked_until).toBeNull();

    sendReceiptSpy.mockRestore();
  });

  test("cancels a queued receipt when parent WhatsApp contact is missing", async () => {
    await pool.query(
      `UPDATE students
     SET parent_whatsapp = NULL
     WHERE id = $1 AND organization_id = $2`,
      [studentId, organizationId],
    );

    const results = await worker.processBatch();

    expect(results).toEqual({
      claimed: 1,
      sent: 0,
      cancelled: 1,
      retried: 0,
      failed: 0,
      deliveryUnknown: 0,
    });

    const saved = await pool.query(
      `SELECT status
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(saved.rows[0].status).toBe("cancelled");
  });

  test("retries a receipt when the provider has a temporary failure", async () => {
    worker.whatsappProvider.sendReceipt = jest.fn().mockRejectedValue(
      Object.assign(new Error("Temporary provider outage"), {
        retryable: true,
      }),
    );

    const results = await worker.processBatch();

    expect(results).toEqual({
      claimed: 1,
      sent: 0,
      cancelled: 0,
      retried: 1,
      failed: 0,
      deliveryUnknown: 0,
    });

    const saved = await pool.query(
      `SELECT status, attempt_count, locked_by, next_attempt_at
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(saved.rows[0].status).toBe("queued");
    expect(saved.rows[0].attempt_count).toBe(1);
    expect(saved.rows[0].locked_by).toBeNull();
    expect(new Date(saved.rows[0].next_attempt_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  test("marks a receipt as failed when the retry limit is reached", async () => {
    const failingProvider = {
      sendReceipt: jest.fn().mockRejectedValue(
        Object.assign(new Error("Temporary provider outage"), {
          retryable: true,
        }),
      ),
    };

    const retryLimitWorker = new MessageWorker({
      messageRepository,
      consentRepository,
      invoiceRepository,
      studentRepository,
      paymentRepository,
      whatsappProvider: failingProvider,
      workerId: "worker-retry-limit-test",
      maxAttempts: 1,
    });

    const results = await retryLimitWorker.processBatch();

    expect(results).toEqual({
      claimed: 1,
      sent: 0,
      cancelled: 0,
      retried: 0,
      failed: 1,
      deliveryUnknown: 0,
    });

    const saved = await pool.query(
      `SELECT status, attempt_count, locked_by, locked_until
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(saved.rows[0].status).toBe("failed");
    expect(saved.rows[0].attempt_count).toBe(1);
    expect(saved.rows[0].locked_by).toBeNull();
    expect(saved.rows[0].locked_until).toBeNull();
  });

  test("marks receipt delivery as unknown when provider outcome is ambiguous", async () => {
    worker.whatsappProvider.sendReceipt = jest.fn().mockRejectedValue(
      Object.assign(new Error("Provider request timed out"), {
        deliveryUnknown: true,
        retryable: false,
      }),
    );

    const results = await worker.processBatch();

    expect(results).toMatchObject({
      claimed: 1,
      sent: 0,
      cancelled: 0,
      retried: 0,
      failed: 0,
      deliveryUnknown: 1,
    });

    const result = await pool.query(
      `SELECT status, attempt_count, locked_by, locked_until
   FROM whatsapp_messages
   WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0]).toMatchObject({
      status: "delivery_unknown",
      attempt_count: 1,
      locked_by: null,
      locked_until: null,
    });
  });

  test("waits for active WhatsApp delivery before closing the worker pool", async () => {
    let notifyProviderStarted;
    let releaseProvider;

    const providerStarted = new Promise((resolve) => {
      notifyProviderStarted = resolve;
    });

    const providerResponse = new Promise((resolve) => {
      releaseProvider = resolve;
    });

    worker.whatsappProvider.sendReceipt = jest.fn(() => {
      notifyProviderStarted();
      return providerResponse;
    });

    // Start processing the batch.
    const batchPromise = worker.processBatch();

    // Wait until the WhatsApp provider request has started.
    await providerStarted;

    let poolClosed = false;

    const closePool = jest.fn(async () => {
      poolClosed = true;
    });

    // Simulate the runner's graceful shutdown sequence.
    const shutdownPromise = (async () => {
      const results = await batchPromise;

      await closePool();

      return results;
    })();

    // The provider is still waiting for a response.
    // Therefore, shutdown must not close the pool.
    expect(closePool).not.toHaveBeenCalled();
    expect(poolClosed).toBe(false);

    // Allow the WhatsApp provider to finish.
    releaseProvider({
      providerMessageId: "mock-graceful-shutdown-001",
    });

    const results = await shutdownPromise;

    expect(results).toEqual({
      claimed: 1,
      sent: 1,
      cancelled: 0,
      retried: 0,
      failed: 0,
      deliveryUnknown: 0,
    });

    expect(closePool).toHaveBeenCalledTimes(1);
    expect(poolClosed).toBe(true);

    // Verify the actual PostgreSQL message state.
    const saved = await pool.query(
      `SELECT status, provider_message_id, locked_by, locked_until
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(saved.rows).toHaveLength(1);

    expect(saved.rows[0]).toMatchObject({
      status: "sent",
      provider_message_id: "mock-graceful-shutdown-001",
      locked_by: null,
      locked_until: null,
    });
  });

  test("renews an active message lease", async () => {
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "worker-integration-test",
      batchSize: 1,
      leaseSeconds: 10,
    });

    expect(message).toBeDefined();

    const renewed = await messageRepository.renewLease({
      messageId: message.id,
      workerId: "worker-integration-test",
      leaseSeconds: 120,
    });

    expect(renewed).not.toBeNull();
    expect(renewed.id).toBe(message.id);
    expect(new Date(renewed.locked_until).getTime()).toBeGreaterThan(
      new Date(message.locked_until).getTime(),
    );
  });

  test("records provider acceptance when the original lease-based update fails", async () => {
    const markAsSentSpy = jest
      .spyOn(messageRepository, "markAsSent")
      .mockResolvedValueOnce(false);

    try {
      const results = await worker.processBatch();

      expect(results).toEqual({
        claimed: 1,
        sent: 1,
        cancelled: 0,
        retried: 0,
        failed: 0,
        deliveryUnknown: 0,
      });

      const savedMessage = await pool.query(
        `SELECT status, provider_message_id, locked_by, locked_until
       FROM whatsapp_messages
       WHERE organization_id = $1`,
        [organizationId],
      );

      expect(savedMessage.rows).toHaveLength(1);
      expect(savedMessage.rows[0].status).toBe("sent");
      expect(savedMessage.rows[0].provider_message_id).toMatch(/^mock-/);
      expect(savedMessage.rows[0].locked_by).toBeNull();
      expect(savedMessage.rows[0].locked_until).toBeNull();
    } finally {
      markAsSentSpy.mockRestore();
    }
  });

  test("prevents stale worker from recording provider acceptance after ownership changes", async () => {
    const workerAId = "worker-a";
    const workerBId = "worker-b";

    // Worker A claims the queued message.
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: workerAId,
      batchSize: 1,
      leaseSeconds: 120,
    });

    expect(message).toBeDefined();

    // Simulate Worker B taking ownership after Worker A's lease expires.
    await pool.query(
      `UPDATE whatsapp_messages
     SET
       locked_by = $2,
       locked_until = clock_timestamp() + INTERVAL '120 seconds'
     WHERE id = $1
       AND status = 'processing'`,
      [message.id, workerBId],
    );

    // Worker A tries to recover provider acceptance using its stale ownership.
    const accepted = await messageRepository.recordProviderAcceptance({
      messageId: message.id,
      workerId: workerAId,
      providerMessageId: "provider-message-from-worker-a",
    });

    expect(accepted).toBe(false);

    // Worker B's ownership and message state must remain untouched.
    const saved = await pool.query(
      `SELECT status, locked_by, provider_message_id
     FROM whatsapp_messages
     WHERE id = $1`,
      [message.id],
    );

    expect(saved.rows[0]).toMatchObject({
      status: "processing",
      locked_by: workerBId,
      provider_message_id: null,
    });
  });

  describe("Batch heartbeat", () => {
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    test("automatically renews active message leases", async () => {
      jest.useFakeTimers();

      const message = { id: randomUUID() };

      const renewSpy = jest
        .spyOn(messageRepository, "renewLease")
        .mockResolvedValue(true);

      const heartbeat = worker.startBatchHeartbeat([message]);

      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 1000,
      );

      expect(renewSpy).toHaveBeenCalledWith({
        messageId: message.id,
        workerId: worker.workerId,
        leaseSeconds: worker.leaseSeconds,
      });

      expect(heartbeat.getState(message.id)).toBe("owned");

      await heartbeat.stop();
    });

    test("marks lease as lost when renewal returns false", async () => {
      jest.useFakeTimers();

      const message = { id: randomUUID() };

      jest.spyOn(messageRepository, "renewLease").mockResolvedValue(false);

      const heartbeat = worker.startBatchHeartbeat([message]);

      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 1000,
      );

      expect(heartbeat.getState(message.id)).toBe("lost");

      await heartbeat.stop();
    });

    test("stops renewing leases after stop is called", async () => {
      jest.useFakeTimers();

      const message = { id: randomUUID() };

      const renewSpy = jest
        .spyOn(messageRepository, "renewLease")
        .mockResolvedValue(true);

      const heartbeat = worker.startBatchHeartbeat([message]);

      await heartbeat.stop();

      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 2000,
      );

      expect(renewSpy).not.toHaveBeenCalled();
    });

    test("prevents overlapping lease renewals", async () => {
      jest.useFakeTimers();

      const message = { id: randomUUID() };

      let resolveRenewal;

      const pendingRenewal = new Promise((resolve) => {
        resolveRenewal = resolve;
      });

      const renewSpy = jest
        .spyOn(messageRepository, "renewLease")
        .mockReturnValue(pendingRenewal);

      const heartbeat = worker.startBatchHeartbeat([message]);

      // First heartbeat starts.
      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 1000,
      );

      expect(renewSpy).toHaveBeenCalledTimes(1);

      // Another interval passes while the first renewal is pending.
      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 1000,
      );

      // Second renewal must not start.
      expect(renewSpy).toHaveBeenCalledTimes(1);

      // Complete the first renewal.
      resolveRenewal(true);

      await heartbeat.stop();

      expect(heartbeat.getState(message.id)).toBe("owned");
    });

    test("marks lease as unknown when renewal throws an error", async () => {
      jest.useFakeTimers();

      const message = { id: randomUUID() };

      const databaseError = new Error("Database connection lost");

      jest
        .spyOn(messageRepository, "renewLease")
        .mockRejectedValue(databaseError);

      const heartbeat = worker.startBatchHeartbeat([message]);

      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 1000,
      );

      expect(heartbeat.getState(message.id)).toBe("unknown");

      await heartbeat.stop();
    });

    test("recovers lease ownership after a temporary renewal error", async () => {
      jest.useFakeTimers();

      const message = { id: randomUUID() };

      const renewSpy = jest
        .spyOn(messageRepository, "renewLease")
        .mockRejectedValueOnce(new Error("Temporary database error"))
        .mockResolvedValueOnce(true);

      const heartbeat = worker.startBatchHeartbeat([message]);

      // First renewal fails.
      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 1000,
      );

      expect(heartbeat.getState(message.id)).toBe("unknown");

      // Second renewal succeeds.
      await jest.advanceTimersByTimeAsync(
        worker.heartbeatIntervalSeconds * 1000,
      );

      expect(heartbeat.getState(message.id)).toBe("owned");
      expect(renewSpy).toHaveBeenCalledTimes(2);

      await heartbeat.stop();
    });

    test("does not send receipt when lease ownership is unknown", async () => {
      const message = {
        id: randomUUID(),
        organization_id: randomUUID(),
        student_id: randomUUID(),
        invoice_id: randomUUID(),
        payment_id: randomUUID(),
        purpose: "receipt",
      };

      const sendReceipt = jest.fn();

      const testWorker = new MessageWorker({
        messageRepository,
        consentRepository: {
          findLatestConsent: jest.fn().mockResolvedValue({
            action: "granted",
          }),
        },
        invoiceRepository: {
          findById: jest.fn().mockResolvedValue({
            lifecycle_status: "active",
          }),
        },
        studentRepository: {
          findContactById: jest.fn().mockResolvedValue({
            parent_whatsapp: "9999999999",
            parent_name: "Test Parent",
          }),
        },
        paymentRepository: {
          findReceiptDetails: jest.fn().mockResolvedValue({
            receipt_number: "FP-TEST-001",
            amount: "500.00",
            payment_method: "cash",
            received_at: new Date(),
            invoice_description: "Monthly Fee",
          }),
        },
        whatsappProvider: { sendReceipt },
        workerId: "heartbeat-test-worker",
        heartbeatIntervalSeconds: 10,
        leaseSeconds: 120,
      });

      await expect(
        testWorker.processMessage(message, () => false),
      ).rejects.toMatchObject({
        leaseOwnershipUncertain: true,
      });

      expect(sendReceipt).not.toHaveBeenCalled();
    });

    test("does not send receipt when final database lease confirmation fails", async () => {
      const workerBId = "worker-b-final-confirmation";

      const originalRenewLease =
        messageRepository.renewLease.bind(messageRepository);

      let renewalCount = 0;

      const renewLeaseSpy = jest
        .spyOn(messageRepository, "renewLease")
        .mockImplementation(async (args) => {
          renewalCount++;

          // First confirmation: Worker A still owns the lease.
          if (renewalCount === 1) {
            return originalRenewLease(args);
          }

          // Before the second confirmation, Worker B takes ownership.
          if (renewalCount === 2) {
            await pool.query(
              `UPDATE whatsapp_messages
           SET locked_by = $2
           WHERE id = $1`,
              [args.messageId, workerBId],
            );

            return originalRenewLease(args);
          }

          return originalRenewLease(args);
        });

      const sendReceiptSpy = jest.spyOn(worker.whatsappProvider, "sendReceipt");

      try {
        const results = await worker.processBatch();

        expect(results).toEqual({
          claimed: 1,
          sent: 0,
          cancelled: 0,
          retried: 0,
          failed: 0,
          deliveryUnknown: 0,
        });

        expect(renewLeaseSpy).toHaveBeenCalledTimes(2);
        expect(sendReceiptSpy).not.toHaveBeenCalled();

        const saved = await pool.query(
          `SELECT status, locked_by, provider_message_id
       FROM whatsapp_messages
       WHERE organization_id = $1`,
          [organizationId],
        );

        expect(saved.rows[0]).toMatchObject({
          status: "processing",
          locked_by: workerBId,
          provider_message_id: null,
        });
      } finally {
        renewLeaseSpy.mockRestore();
        sendReceiptSpy.mockRestore();
      }
    });
  });
});
