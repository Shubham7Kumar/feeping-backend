
const MessageWorker = require("./message.worker");
const MockWhatsAppProvider = require("./providers/mock-whatsapp.provider");
const env = require("../../config/env");

function createWhatsAppProvider(options = {}) {
  // Allow tests or other callers to inject their own provider.
  if (options.whatsappProvider) {
    return options.whatsappProvider;
  }

  if (env.WHATSAPP_PROVIDER === "meta") {
    const MetaWhatsAppProvider = require("./providers/meta-whatsapp.provider");

    return new MetaWhatsAppProvider({
      phoneNumberId: env.META_PHONE_NUMBER_ID,
      accessToken: env.META_ACCESS_TOKEN,
      apiVersion: env.META_API_VERSION,
      templateName: env.WHATSAPP_RECEIPT_TEMPLATE_NAME,
      templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
    });
  }

  return new MockWhatsAppProvider();
}

function createMessageWorker(container, options = {}) {
  const whatsappProvider = createWhatsAppProvider(options);

  return new MessageWorker({
    messageRepository: container.messageRepository,
    consentRepository: container.consentRepository,
    invoiceRepository: container.invoiceRepository,
    studentRepository: container.studentRepository,
    paymentRepository: container.paymentRepository,
    whatsappProvider,
    workerId: options.workerId || `feeping-worker-${process.pid}`,
    batchSize: options.batchSize || 10,
    leaseSeconds: options.leaseSeconds || 120,
    maxAttempts: options.maxAttempts || 5,
  });
}

module.exports = createMessageWorker;
