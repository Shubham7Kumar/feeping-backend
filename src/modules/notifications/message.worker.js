class MessageWorker {
  constructor({
    messageRepository,
    consentRepository,
    invoiceRepository,
    studentRepository,
    paymentRepository,
    whatsappProvider,
    workerId,
    heartbeatIntervalSeconds = 10,
    batchSize = 10,
    leaseSeconds = 120,
    maxAttempts = 5,
  }) {
    // Worker identity
    if (
      typeof workerId !== "string" ||
      workerId.trim().length === 0 ||
      workerId.length > 100
    ) {
      throw new Error("A valid workerId is required");
    }

    // Required dependencies
    const dependencies = {
      messageRepository,
      consentRepository,
      invoiceRepository,
      studentRepository,
      paymentRepository,
      whatsappProvider,
    };

    for (const [name, dependency] of Object.entries(dependencies)) {
      if (!dependency || typeof dependency !== "object") {
        throw new Error(`${name} dependency is required`);
      }
    }

    // Batch size
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error("batchSize must be between 1 and 100");
    }

    // Lease duration
    if (
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 10 ||
      leaseSeconds > 900
    ) {
      throw new Error("leaseSeconds must be between 10 and 900");
    }

    // Heartbeat interval
    if (
      !Number.isInteger(heartbeatIntervalSeconds) ||
      heartbeatIntervalSeconds < 1 ||
      heartbeatIntervalSeconds > Math.floor(leaseSeconds / 3)
    ) {
      throw new Error(
        "heartbeatIntervalSeconds must be between 1 and leaseSeconds / 3",
      );
    }

    // Retry limit
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error("maxAttempts must be between 1 and 20");
    }

    this.messageRepository = messageRepository;
    this.consentRepository = consentRepository;
    this.invoiceRepository = invoiceRepository;
    this.studentRepository = studentRepository;
    this.paymentRepository = paymentRepository;
    this.whatsappProvider = whatsappProvider;

    this.workerId = workerId.trim();
    this.batchSize = batchSize;
    this.leaseSeconds = leaseSeconds;
    this.heartbeatIntervalSeconds = heartbeatIntervalSeconds;
    this.maxAttempts = maxAttempts;
  }

  startBatchHeartbeat(messages) {
    const leaseStates = new Map(
      messages.map((message) => [message.id, "owned"]),
    );

    const activeMessageIds = new Set(messages.map((message) => message.id));

    let heartbeatRunning = false;
    let heartbeatPromise = Promise.resolve();

    const renewOneLease = async (messageId) => {
      try {
        const renewed = await this.messageRepository.renewLease({
          messageId,
          workerId: this.workerId,
          leaseSeconds: this.leaseSeconds,
        });

        const state = renewed ? "owned" : "lost";

        leaseStates.set(messageId, state);

        return state === "owned";
      } catch (error) {
        leaseStates.set(messageId, "unknown");

        console.error(`Could not renew lease for message ${messageId}`, error);

        return false;
      }
    };

    const renewLeases = async () => {
      if (heartbeatRunning) return;

      heartbeatRunning = true;

      try {
        await Promise.all(
          [...activeMessageIds].map(async (messageId) => {
            await renewOneLease(messageId);
          }),
        );
      } finally {
        heartbeatRunning = false;
      }
    };

    const confirmOwnership = async (messageId) => {
      if (!activeMessageIds.has(messageId)) {
        return false;
      }

      // Wait for any existing heartbeat renewal.
      while (heartbeatRunning) {
        await heartbeatPromise;
      }

      // The message might have been released while waiting.
      if (!activeMessageIds.has(messageId)) {
        return false;
      }

      // Prevent periodic heartbeat from overlapping confirmation.
      heartbeatRunning = true;

      heartbeatPromise = (async () => {
        try {
          return await renewOneLease(messageId);
        } finally {
          heartbeatRunning = false;
        }
      })();

      return heartbeatPromise;
    };

    const timer = setInterval(() => {
      if (!heartbeatRunning) {
        heartbeatPromise = renewLeases();
      }
    }, this.heartbeatIntervalSeconds * 1000);

    return {
      getState(messageId) {
        return leaseStates.get(messageId);
      },

      confirmOwnership,

      release(messageId) {
        activeMessageIds.delete(messageId);
      },

      async stop() {
        clearInterval(timer);
        await heartbeatPromise;
      },
    };
  }

  async processBatch() {
    const messages = await this.messageRepository.claimQueuedMessages({
      workerId: this.workerId,
      batchSize: this.batchSize,
      leaseSeconds: this.leaseSeconds,
      maxAttempts: this.maxAttempts,
    });

    const results = {
      claimed: messages.length,
      sent: 0,
      cancelled: 0,
      retried: 0,
      failed: 0,
      deliveryUnknown: 0,
    };

    if (messages.length === 0) {
      return results;
    }

    const heartbeat = this.startBatchHeartbeat(messages);

    try {
      // Process messages sequentially.
      for (const message of messages) {
        const leaseState = heartbeat.getState(message.id);

        // Never start processing if lease ownership is uncertain or lost.
        if (leaseState !== "owned") {
          console.error(
            `Skipping message ${message.id}: lease state is ${leaseState}`,
          );

          heartbeat.release(message.id);
          continue;
        }

        try {
          const outcome = await this.processMessage(message, () =>
            heartbeat.confirmOwnership(message.id),
          );

          results[outcome]++;
        } catch (error) {
          console.error(`Failed to process message ${message.id}:`, error);

          // Do not update a message if this worker no longer
          // has confirmed ownership of its lease.
          const currentLeaseState = heartbeat.getState(message.id);

          if (
            error.leaseOwnershipUncertain === true ||
            currentLeaseState !== "owned"
          ) {
            console.error(
              `Cannot update message ${message.id}: lease state is ${currentLeaseState}`,
            );

            continue;
          }

          try {
            let updatedMessage;

            if (error.deliveryUnknown === true) {
              updatedMessage = await this.messageRepository.markDeliveryUnknown(
                {
                  messageId: message.id,
                  workerId: this.workerId,
                  errorMessage: error.message,
                },
              );

              if (updatedMessage) {
                results.deliveryUnknown++;
              }
            } else if (error.retryable === false) {
              updatedMessage = await this.messageRepository.markAsFailed({
                messageId: message.id,
                workerId: this.workerId,
                errorMessage: error.message,
              });

              if (updatedMessage) {
                results.failed++;
              }
            } else {
              const delaySeconds = Math.min(
                30 * 2 ** Math.max(message.attempt_count - 1, 0),
                3600,
              );

              const retryAt = new Date(Date.now() + delaySeconds * 1000);

              updatedMessage = await this.messageRepository.scheduleRetry({
                messageId: message.id,
                workerId: this.workerId,
                retryAt,
                errorMessage: error.message,
                maxAttempts: this.maxAttempts,
              });

              if (updatedMessage) {
                if (updatedMessage.status === "failed") {
                  results.failed++;
                } else {
                  results.retried++;
                }
              }
            }

            if (!updatedMessage) {
              console.error(
                `Could not update message ${message.id}: lease may have expired or been lost`,
              );
            }
          } catch (updateError) {
            console.error(
              `Could not update message ${message.id} after processing failure:`,
              updateError,
            );
          }
        } finally {
          // Remove this message from future heartbeat renewals.
          heartbeat.release(message.id);
        }
      }

      return results;
    } finally {
      // Stop the timer only after the entire batch has finished.
      await heartbeat.stop();
    }
  }

  async processMessage(message, isLeaseOwned = () => true) {
    const {
      id,
      organization_id: organizationId,
      student_id: studentId,
      invoice_id: invoiceId,
      payment_id: paymentId,
      purpose,
    } = message;

    if (!(await isLeaseOwned())) {
      const error = new Error(
        "Cannot send receipt: lease ownership is not confirmed",
      );

      error.leaseOwnershipUncertain = true;

      throw error;
    }

    // MVP currently supports receipt messages only.
    if (purpose !== "receipt" || !paymentId) {
      const error = new Error("Unsupported message type");
      error.retryable = false;
      throw error;
    }

    // Always check the latest consent, not just the consent
    // event referenced when the message was originally queued.
    const consent = await this.consentRepository.findLatestConsent(
      organizationId,
      studentId,
      purpose,
    );

    if (!consent || consent.action !== "granted") {
      return this.cancelMessage(id, "Consent is not currently granted");
    }

    const invoice = await this.invoiceRepository.findById(
      invoiceId,
      organizationId,
    );

    if (!invoice || invoice.lifecycle_status !== "active") {
      return this.cancelMessage(id, "Invoice is unavailable or cancelled");
    }

    const student = await this.studentRepository.findContactById(
      studentId,
      organizationId,
    );

    if (!student || !student.parent_whatsapp) {
      return this.cancelMessage(id, "Parent WhatsApp contact is unavailable");
    }

    const receipt = await this.paymentRepository.findReceiptDetails(
      paymentId,
      invoiceId,
      organizationId,
    );

    if (!receipt) {
      return this.cancelMessage(id, "Receipt details could not be found");
    }

    // Recheck lease ownership immediately before external provider call.
    if (!(await isLeaseOwned())) {
      const error = new Error(
        "Cannot send receipt: lease ownership is not confirmed",
      );

      error.leaseOwnershipUncertain = true;

      throw error;
    }

    const providerResult = await this.whatsappProvider.sendReceipt({
      organizationId,
      to: student.parent_whatsapp,
      studentName: student.parent_name || "Parent",
      receipt: {
        receiptNumber: receipt.receipt_number,
        amount: receipt.amount,
        paymentMethod: receipt.payment_method,
        receivedAt: receipt.received_at,
        invoiceDescription: receipt.invoice_description,
      },
    });

    if (!providerResult?.providerMessageId) {
      const error = new Error("WhatsApp provider did not return a message ID");
      error.deliveryUnknown = true;
      error.retryable = true;
      throw error;
    }

    const markedSent = await this.messageRepository.markAsSent({
      messageId: id,
      workerId: this.workerId,
      providerMessageId: providerResult.providerMessageId,
    });

    if (markedSent) {
      return "sent";
    }

    console.warn(
      `Lease-based update failed for ${id}. Attempting provider acceptance recovery.`,
    );

    const acceptanceRecorded =
      await this.messageRepository.recordProviderAcceptance({
        messageId: id,
        workerId: this.workerId,
        providerMessageId: providerResult.providerMessageId,
      });

    console.log("Provider acceptance recovery result:", {
      messageId: id,
      providerMessageId: providerResult.providerMessageId,
      acceptanceRecorded,
    });

    if (acceptanceRecorded) {
      console.warn(`Provider acceptance recovered for message ${id}`);
      return "sent";
    }

    const error = new Error(
      `Provider accepted message ${id}, but acceptance could not be persisted. Manual reconciliation required.`,
    );

    error.deliveryUnknown = true;
    error.retryable = false;

    throw error;
  }

  async cancelMessage(messageId, reason) {
    const result = await this.messageRepository.cancelClaimedMessage({
      messageId,
      workerId: this.workerId,
      reason,
    });

    if (!result) {
      const error = new Error(
        `Could not cancel message ${messageId}: lease ownership may have changed`,
      );

      error.leaseOwnershipUncertain = true;
      throw error;
    }

    return "cancelled";
  }
}

module.exports = MessageWorker;
