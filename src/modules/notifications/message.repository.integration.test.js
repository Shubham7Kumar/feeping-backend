require("dotenv").config();

const { randomUUID } = require("crypto");

const createPool = require("../../infrastructure/database/createPool");
const MessageRepository = require("./message.repository");

describe("MessageRepository PostgreSQL integration", () => {
  let pool;
  let messageRepository;

  let organizationId;
  let userId;
  let studentId;
  let invoiceId;

  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    pool = createPool(process.env.TEST_DATABASE_URL, {
      ssl: false,
    });

    messageRepository = new MessageRepository(pool);
  });

  async function createQueuedMessage() {
    const paymentResult = await pool.query(
      `INSERT INTO payments (
        organization_id,
        invoice_id,
        receipt_number,
        amount,
        payment_method,
        received_at,
        idempotency_key,
        request_fingerprint,
        recorded_by
      )
      VALUES ($1, $2, $3, 100, 'cash', NOW(), $4, $5, $6)
      RETURNING id`,
      [
        organizationId,
        invoiceId,
        `FP-${randomUUID()}`,
        randomUUID(),
        "test-fingerprint",
        userId,
      ],
    );

    const paymentId = paymentResult.rows[0].id;

    const consentResult = await pool.query(
      `INSERT INTO whatsapp_consents (
        organization_id,
        student_id,
        purpose,
        action,
        source,
        recorded_by
      )
      VALUES ($1, $2, 'receipt', 'granted', 'test', $3)
      RETURNING id`,
      [organizationId, studentId, userId],
    );

    const consentId = consentResult.rows[0].id;

    return messageRepository.queueReceipt(
      {
        organizationId,
        studentId,
        invoiceId,
        paymentId,
        consentId,
      },
      pool,
    );
  }

  beforeEach(async () => {
    const organization = await pool.query(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id`,
      [`Message Test ${randomUUID()}`],
    );

    organizationId = organization.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (
        organization_id,
        name,
        email,
        password_hash,
        role
      )
      VALUES ($1, $2, $3, $4, 'owner')
      RETURNING id`,
      [
        organizationId,
        "Message Test Owner",
        `owner-${randomUUID()}@test.com`,
        "test-password-hash",
      ],
    );

    userId = user.rows[0].id;

    const student = await pool.query(
      `INSERT INTO students (
        organization_id,
        name
      )
      VALUES ($1, $2)
      RETURNING id`,
      [organizationId, "Message Test Student"],
    );

    studentId = student.rows[0].id;

    const invoice = await pool.query(
      `INSERT INTO fee_invoices (
        organization_id,
        student_id,
        description,
        amount_due,
        due_date,
        created_by
      )
      VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
      RETURNING id`,
      [organizationId, studentId, "Test invoice", 1000, userId],
    );

    invoiceId = invoice.rows[0].id;

    await createQueuedMessage();
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
      `DELETE FROM payment_adjustments
       WHERE organization_id = $1`,
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

  test("claims queued messages and assigns a processing lease", async () => {
    const messages = await messageRepository.claimQueuedMessages({
      workerId: "worker-test-1",
      batchSize: 10,
      leaseSeconds: 60,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("processing");
    expect(messages[0].locked_by).toBe("worker-test-1");
    expect(messages[0].locked_until).not.toBeNull();
    expect(messages[0].attempt_count).toBe(1);
  });

  test("does not allow two workers to claim the same message", async () => {
    const [workerA, workerB] = await Promise.all([
      messageRepository.claimQueuedMessages({
        workerId: "worker-A",
      }),
      messageRepository.claimQueuedMessages({
        workerId: "worker-B",
      }),
    ]);

    const claimedMessages = [...workerA, ...workerB];

    expect(claimedMessages).toHaveLength(1);

    expect(["worker-A", "worker-B"]).toContain(claimedMessages[0].locked_by);
  });

  test("respects the requested batch size", async () => {
    await createQueuedMessage();
    await createQueuedMessage();

    const messages = await messageRepository.claimQueuedMessages({
      workerId: "worker-batch",
      batchSize: 2,
    });

    expect(messages).toHaveLength(2);
  });

  test("does not claim messages scheduled for the future", async () => {
    await pool.query(
      `UPDATE whatsapp_messages
       SET next_attempt_at = NOW() + INTERVAL '1 hour'
       WHERE organization_id = $1`,
      [organizationId],
    );

    const messages = await messageRepository.claimQueuedMessages({
      workerId: "worker-future",
    });

    expect(messages).toHaveLength(0);
  });

  test("rejects invalid worker configuration", async () => {
    await expect(
      messageRepository.claimQueuedMessages({
        workerId: "",
      }),
    ).rejects.toThrow("A valid workerId is required");

    await expect(
      messageRepository.claimQueuedMessages({
        workerId: "worker-test",
        batchSize: 101,
      }),
    ).rejects.toThrow("batchSize must be between 1 and 100");

    await expect(
      messageRepository.claimQueuedMessages({
        workerId: "worker-test",
        leaseSeconds: 5,
      }),
    ).rejects.toThrow("leaseSeconds must be between 10 and 900");
  });

  test("reclaims a message after its processing lease expires", async () => {
    await pool.query(
      `UPDATE whatsapp_messages
     SET
       status = 'processing',
       locked_by = 'crashed-worker',
       locked_until = NOW() - INTERVAL '1 second',
       attempt_count = 1
     WHERE organization_id = $1`,
      [organizationId],
    );

    const messages = await messageRepository.claimQueuedMessages({
      workerId: "recovery-worker",
      leaseSeconds: 60,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("processing");
    expect(messages[0].locked_by).toBe("recovery-worker");
    expect(messages[0].attempt_count).toBe(2);
  });

  test("does not reclaim a message while another worker has an active lease", async () => {
    await pool.query(
      `UPDATE whatsapp_messages
     SET
       status = 'processing',
       locked_by = 'active-worker',
       locked_until = NOW() + INTERVAL '60 seconds',
       attempt_count = 1
     WHERE organization_id = $1`,
      [organizationId],
    );

    const messages = await messageRepository.claimQueuedMessages({
      workerId: "second-worker",
      leaseSeconds: 60,
    });

    expect(messages).toHaveLength(0);

    const result = await pool.query(
      `SELECT status, locked_by, attempt_count
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].status).toBe("processing");
    expect(result.rows[0].locked_by).toBe("active-worker");
    expect(result.rows[0].attempt_count).toBe(1);
  });

  test("marks a message as sent when the worker owns the active lease", async () => {
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "worker-one",
    });

    const success = await messageRepository.markAsSent({
      messageId: message.id,
      workerId: "worker-one",
      providerMessageId: "wamid.test123",
    });

    expect(success).toBe(true);

    const result = await pool.query(
      `SELECT status, provider_message_id, sent_at, locked_by, locked_until
     FROM whatsapp_messages WHERE id = $1`,
      [message.id],
    );

    expect(result.rows[0].status).toBe("sent");
    expect(result.rows[0].provider_message_id).toBe("wamid.test123");
    expect(result.rows[0].sent_at).not.toBeNull();
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].locked_until).toBeNull();
  });

  test("does not allow another worker to mark a message as sent", async () => {
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "worker-one",
    });

    const success = await messageRepository.markAsSent({
      messageId: message.id,
      workerId: "worker-two",
      providerMessageId: "wamid.test456",
    });

    expect(success).toBe(false);
  });

  test("schedules a retry for a temporary delivery failure", async () => {
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "worker-one",
    });

    const retryAt = new Date(Date.now() + 60_000);

    const result = await messageRepository.scheduleRetry({
      messageId: message.id,
      workerId: "worker-one",
      retryAt,
      errorMessage: "Temporary provider error",
    });

    expect(result.status).toBe("queued");

    const saved = await pool.query(
      `SELECT status, attempt_count, last_error, locked_by
     FROM whatsapp_messages WHERE id = $1`,
      [message.id],
    );

    expect(saved.rows[0].status).toBe("queued");
    expect(saved.rows[0].attempt_count).toBe(1);
    expect(saved.rows[0].last_error).toBe("Temporary provider error");
    expect(saved.rows[0].locked_by).toBeNull();
  });

  test("marks a message failed after reaching the retry limit", async () => {
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "worker-one",
    });

    const result = await messageRepository.scheduleRetry({
      messageId: message.id,
      workerId: "worker-one",
      retryAt: new Date(Date.now() + 60_000),
      errorMessage: "Temporary provider error",
      maxAttempts: 1,
    });

    expect(result.status).toBe("failed");
  });

  test("marks a permanently failed message and clears its lease", async () => {
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "worker-one",
    });

    const success = await messageRepository.markAsFailed({
      messageId: message.id,
      workerId: "worker-one",
      errorMessage: "Invalid recipient",
    });

    expect(success).toBe(true);

    const result = await pool.query(
      `SELECT status, last_error, locked_by, locked_until
     FROM whatsapp_messages WHERE id = $1`,
      [message.id],
    );

    expect(result.rows[0].status).toBe("failed");
    expect(result.rows[0].last_error).toBe("Invalid recipient");
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].locked_until).toBeNull();
  });

  test("does not allow an expired lease owner to update a message", async () => {
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "worker-one",
    });

    await pool.query(
      `UPDATE whatsapp_messages
     SET locked_until = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
      [message.id],
    );

    const success = await messageRepository.markAsSent({
      messageId: message.id,
      workerId: "worker-one",
      providerMessageId: "wamid.expired",
    });

    expect(success).toBe(false);
  });

  test("marks an expired message as failed when maximum attempts are reached", async () => {
    await pool.query(
      `UPDATE whatsapp_messages
     SET
       status = 'processing',
       locked_by = 'crashed-worker',
       locked_until = clock_timestamp() - INTERVAL '1 second',
       attempt_count = 5
     WHERE organization_id = $1`,
      [organizationId],
    );

    const messages = await messageRepository.claimQueuedMessages({
      workerId: "recovery-worker",
      maxAttempts: 5,
    });

    expect(messages).toHaveLength(0);

    const result = await pool.query(
      `SELECT status, attempt_count, last_error, locked_by, locked_until
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].status).toBe("failed");
    expect(result.rows[0].attempt_count).toBe(5);
    expect(result.rows[0].last_error).toBe(
      "Maximum attempts reached after lease expiration",
    );
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].locked_until).toBeNull();
  });
  test("marks an expired message as failed when maximum attempts are reached", async () => {
    await pool.query(
      `UPDATE whatsapp_messages
     SET
       status = 'processing',
       locked_by = 'crashed-worker',
       locked_until = clock_timestamp() - INTERVAL '1 second',
       attempt_count = 5
     WHERE organization_id = $1`,
      [organizationId],
    );

    const messages = await messageRepository.claimQueuedMessages({
      workerId: "recovery-worker",
      maxAttempts: 5,
    });

    expect(messages).toHaveLength(0);

    const result = await pool.query(
      `SELECT status, attempt_count, last_error, locked_by, locked_until
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].status).toBe("failed");
    expect(result.rows[0].attempt_count).toBe(5);
    expect(result.rows[0].last_error).toBe(
      "Maximum attempts reached after lease expiration",
    );
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].locked_until).toBeNull();
  });
  test("marks an exhausted queued message as failed", async () => {
    await pool.query(
      `UPDATE whatsapp_messages
     SET
       status = 'queued',
       locked_by = NULL,
       locked_until = NULL,
       attempt_count = 5,
       next_attempt_at = clock_timestamp() - INTERVAL '1 second'
     WHERE organization_id = $1`,
      [organizationId],
    );

    const messages = await messageRepository.claimQueuedMessages({
      workerId: "retry-worker",
      maxAttempts: 5,
    });

    expect(messages).toHaveLength(0);

    const result = await pool.query(
      `SELECT status, attempt_count, locked_by, locked_until
     FROM whatsapp_messages
     WHERE organization_id = $1`,
      [organizationId],
    );

    expect(result.rows[0].status).toBe("failed");
    expect(result.rows[0].attempt_count).toBe(5);
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].locked_until).toBeNull();
  });
  test("allows the final permitted attempt but never exceeds maxAttempts", async () => {
    await pool.query(
      `UPDATE whatsapp_messages
     SET
       status = 'processing',
       locked_by = 'crashed-worker',
       locked_until = clock_timestamp() - INTERVAL '1 second',
       attempt_count = 1
     WHERE organization_id = $1`,
      [organizationId],
    );

    // Second attempt is the final permitted attempt.
    const [message] = await messageRepository.claimQueuedMessages({
      workerId: "recovery-worker",
      maxAttempts: 2,
    });

    expect(message).toBeDefined();
    expect(message.attempt_count).toBe(2);

    // Simulate another worker crash.
    await pool.query(
      `UPDATE whatsapp_messages
     SET locked_until = clock_timestamp() - INTERVAL '1 second'
     WHERE id = $1`,
      [message.id],
    );

    // No third attempt should be allowed.
    const messages = await messageRepository.claimQueuedMessages({
      workerId: "another-worker",
      maxAttempts: 2,
    });

    expect(messages).toHaveLength(0);

    const result = await pool.query(
      `SELECT status, attempt_count
     FROM whatsapp_messages
     WHERE id = $1`,
      [message.id],
    );

    expect(result.rows[0].status).toBe("failed");
    expect(result.rows[0].attempt_count).toBe(2);
  });
  test("allows concurrent workers to claim different messages", async () => {
    await createQueuedMessage();
    await createQueuedMessage();

    const [workerA, workerB] = await Promise.all([
      messageRepository.claimQueuedMessages({
        workerId: "worker-A",
        batchSize: 2,
      }),
      messageRepository.claimQueuedMessages({
        workerId: "worker-B",
        batchSize: 2,
      }),
    ]);

    const allMessages = [...workerA, ...workerB];
    const messageIds = allMessages.map((message) => message.id);

    // Every message must be claimed only once.
    expect(new Set(messageIds).size).toBe(messageIds.length);

    // All three queued messages should be claimed.
    expect(allMessages).toHaveLength(3);

    // Each message must have a valid owner.
    for (const message of allMessages) {
      expect(["worker-A", "worker-B"]).toContain(message.locked_by);
      expect(message.status).toBe("processing");
    }
  });
});
