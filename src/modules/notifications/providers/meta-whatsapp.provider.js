
class MetaWhatsAppProvider {
  constructor({
    phoneNumberId,
    accessToken,
    apiVersion,
    templateName,
    templateLanguage = "en_US",
    timeoutMs = 10000,
  }) {
    const required = {
      phoneNumberId,
      accessToken,
      apiVersion,
      templateName,
    };

    for (const [key, value] of Object.entries(required)) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${key} is required`);
      }
    }

    if (!/^v\d+\.\d+$/.test(apiVersion)) {
      throw new Error("Invalid Meta API version");
    }

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
      throw new Error("timeoutMs must be at least 1000");
    }

    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.templateName = templateName;
    this.templateLanguage = templateLanguage;
    this.timeoutMs = timeoutMs;
  }

  normalizePhoneNumber(phoneNumber) {
    if (typeof phoneNumber !== "string") {
      throw new Error("A valid recipient phone number is required");
    }

    const normalized = phoneNumber.replace(/[\s()+-]/g, "");

    if (!/^[1-9]\d{7,14}$/.test(normalized)) {
      throw new Error("Recipient must be a valid international phone number");
    }

    return normalized;
  }

  toTemplateParameter(value) {
    if (value === null || value === undefined) {
      throw new Error("Template parameter cannot be empty");
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return String(value);
  }

  createReceiptPayload({ to, studentName, receipt }) {
    const recipient = this.normalizePhoneNumber(to);

    const parameters = [
      studentName,
      receipt.receiptNumber,
      receipt.invoiceDescription,
      receipt.amount,
      receipt.paymentMethod,
      receipt.receivedAt,
    ].map((value) => ({
      type: "text",
      text: this.toTemplateParameter(value),
    }));

    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "template",
      template: {
        name: this.templateName,
        language: {
          code: this.templateLanguage,
        },
        components: [
          {
            type: "body",
            parameters,
          },
        ],
      },
    };
  }

  async sendReceipt({ to, studentName, receipt }) {
    const payload = this.createReceiptPayload({
      to,
      studentName,
      receipt,
    });

    const url =
      `https://graph.facebook.com/${this.apiVersion}/` +
      `${this.phoneNumberId}/messages`;

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let data;

      try {
        data = await response.json();
      } catch {
        const error = new Error(
          "Meta returned an unreadable response",
        );

        error.deliveryUnknown = response.ok;
        error.retryable = false;
        throw error;
      }

      if (!response.ok) {
        const metaError = data?.error || {};

        const error = new Error(
          metaError.message || "Meta WhatsApp API request failed",
        );

        error.status = response.status;
        error.metaCode = metaError.code;
        error.metaSubcode = metaError.error_subcode;

        error.retryable =
          response.status === 429 ||
          response.status >= 500 ||
          metaError.is_transient === true;

        error.deliveryUnknown = false;

        throw error;
      }

      const providerMessageId = data?.messages?.[0]?.id;

      if (!providerMessageId) {
        const error = new Error(
          "Meta accepted the request but returned no message ID",
        );

        error.deliveryUnknown = true;
        error.retryable = false;

        throw error;
      }

      return { providerMessageId };
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error(
          "Meta WhatsApp request timed out; delivery status is unknown",
        );

        timeoutError.deliveryUnknown = true;
        timeoutError.retryable = false;

        throw timeoutError;
      }

      // A network failure may happen after Meta received the request.
      // Avoid automatic retries that could send duplicate receipts.
      if (
        error.status === undefined &&
        error.deliveryUnknown !== true
      ) {
        error.deliveryUnknown = true;
        error.retryable = false;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = MetaWhatsAppProvider;
