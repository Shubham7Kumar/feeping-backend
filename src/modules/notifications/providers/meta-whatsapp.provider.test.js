
const MetaWhatsAppProvider = require("./meta-whatsapp.provider");

describe("MetaWhatsAppProvider", () => {
  let provider;
  let originalFetch;

  const receiptInput = {
    to: "+919876543210",
    studentName: "Test Parent",
    receipt: {
      receiptNumber: "FP-000001",
      invoiceDescription: "Monthly Tuition Fee",
      amount: "500.00",
      paymentMethod: "UPI",
      receivedAt: "2026-11-05",
    },
  };

  beforeEach(() => {
    originalFetch = global.fetch;

    provider = new MetaWhatsAppProvider({
      phoneNumberId: "test-phone-id",
      accessToken: "test-access-token",
      apiVersion: "v26.0",
      templateName: "feeping_receipt",
      templateLanguage: "en_US",
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe("constructor", () => {
    test("creates provider with valid configuration", () => {
      expect(provider.phoneNumberId).toBe("test-phone-id");
      expect(provider.apiVersion).toBe("v26.0");
    });

    test("rejects missing access token", () => {
      expect(
        () =>
          new MetaWhatsAppProvider({
            phoneNumberId: "phone-id",
            accessToken: "",
            apiVersion: "v26.0",
            templateName: "feeping_receipt",
          }),
      ).toThrow("accessToken is required");
    });

    test("rejects invalid API version", () => {
      expect(
        () =>
          new MetaWhatsAppProvider({
            phoneNumberId: "phone-id",
            accessToken: "token",
            apiVersion: "26.0",
            templateName: "feeping_receipt",
          }),
      ).toThrow("Invalid Meta API version");
    });
  });

  describe("normalizePhoneNumber", () => {
    test("normalizes international phone number", () => {
      expect(
        provider.normalizePhoneNumber("+91 98765-43210"),
      ).toBe("919876543210");
    });

    test("rejects invalid phone number", () => {
      expect(() =>
        provider.normalizePhoneNumber("123"),
      ).toThrow("valid international phone number");
    });
  });

  describe("createReceiptPayload", () => {
    test("creates correct template payload", () => {
      const payload = provider.createReceiptPayload(receiptInput);

      expect(payload.messaging_product).toBe("whatsapp");
      expect(payload.to).toBe("919876543210");
      expect(payload.type).toBe("template");

      expect(payload.template.name).toBe("feeping_receipt");
      expect(payload.template.language.code).toBe("en_US");

      const parameters =
        payload.template.components[0].parameters;

      expect(parameters).toHaveLength(6);

      expect(parameters.map((item) => item.text)).toEqual([
        "Test Parent",
        "FP-000001",
        "Monthly Tuition Fee",
        "500.00",
        "UPI",
        "2026-11-05",
      ]);
    });

    test("rejects missing receipt parameters", () => {
      expect(() =>
        provider.createReceiptPayload({
          ...receiptInput,
          receipt: {
            ...receiptInput.receipt,
            amount: undefined,
          },
        }),
      ).toThrow("Template parameter cannot be empty");
    });
  });

  describe("sendReceipt", () => {
    test("returns provider message ID on success", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [{ id: "wamid.test123" }],
        }),
      });

      const result = await provider.sendReceipt(receiptInput);

      expect(result).toEqual({
        providerMessageId: "wamid.test123",
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);

      const [url, options] = global.fetch.mock.calls[0];

      expect(url).toBe(
        "https://graph.facebook.com/v26.0/test-phone-id/messages",
      );

      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe(
        "Bearer test-access-token",
      );
    });

    test("classifies Meta 400 as non-retryable", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: jest.fn().mockResolvedValue({
          error: {
            message: "Invalid template",
            code: 100,
          },
        }),
      });

      await expect(
        provider.sendReceipt(receiptInput),
      ).rejects.toMatchObject({
        status: 400,
        retryable: false,
        deliveryUnknown: false,
      });
    });

    test("classifies Meta 429 as retryable", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: jest.fn().mockResolvedValue({
          error: {
            message: "Rate limit reached",
          },
        }),
      });

      await expect(
        provider.sendReceipt(receiptInput),
      ).rejects.toMatchObject({
        status: 429,
        retryable: true,
        deliveryUnknown: false,
      });
    });

    test("classifies Meta 500 as retryable", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({
          error: {
            message: "Internal server error",
          },
        }),
      });

      await expect(
        provider.sendReceipt(receiptInput),
      ).rejects.toMatchObject({
        status: 500,
        retryable: true,
        deliveryUnknown: false,
      });
    });

    test("classifies network failure as delivery unknown", async () => {
      global.fetch = jest.fn().mockRejectedValue(
        new TypeError("Network connection failed"),
      );

      await expect(
        provider.sendReceipt(receiptInput),
      ).rejects.toMatchObject({
        deliveryUnknown: true,
        retryable: false,
      });
    });

    test("classifies successful response without message ID as unknown", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          messages: [],
        }),
      });

      await expect(
        provider.sendReceipt(receiptInput),
      ).rejects.toMatchObject({
        deliveryUnknown: true,
        retryable: false,
      });
    });

    test("classifies timeout as delivery unknown", async () => {
      jest.useFakeTimers();

      try {
        global.fetch = jest.fn(
          (url, options) =>
            new Promise((resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => {
                  const error = new Error("Aborted");
                  error.name = "AbortError";
                  reject(error);
                },
              );
            }),
        );

        const promise = provider.sendReceipt(receiptInput);

        const assertion = expect(promise).rejects.toMatchObject({
          deliveryUnknown: true,
          retryable: false,
        });

        await jest.advanceTimersByTimeAsync(5000);

        await assertion;
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
