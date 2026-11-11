
const { randomUUID } = require("node:crypto");

class MockWhatsAppProvider {
  async sendReceipt({ to, studentName, receipt }) {
    if (!to || !receipt?.receiptNumber || !receipt?.amount) {
      const error = new Error("Invalid receipt payload");
      error.retryable = false;
      throw error;
    }

    const providerMessageId = `mock-${randomUUID()}`;

    console.log("[MOCK WHATSAPP] Receipt accepted:", {
      providerMessageId,
      studentName,
      receiptNumber: receipt.receiptNumber,
      amount: receipt.amount,
    });

    return { providerMessageId };
  }
}

module.exports = MockWhatsAppProvider;
