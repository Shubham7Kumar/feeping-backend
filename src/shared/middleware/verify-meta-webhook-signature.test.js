
const crypto = require("crypto");

jest.mock("../../config/env", () => ({
  META_APP_SECRET: "test-meta-app-secret",
}));

const verifyMetaWebhookSignature = require("./verify-meta-webhook-signature");

describe("verifyMetaWebhookSignature", () => {
  let req;
  let res;
  let next;

  const rawBody = Buffer.from(
    JSON.stringify({ object: "whatsapp_business_account" }),
  );

  function createSignature(body = rawBody) {
    return `sha256=${crypto
      .createHmac("sha256", "test-meta-app-secret")
      .update(body)
      .digest("hex")}`;
  }

  beforeEach(() => {
    req = {
      rawBody,
      get: jest.fn().mockReturnValue(createSignature()),
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  test("calls next for a valid signature", () => {
    verifyMetaWebhookSignature(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("rejects an invalid signature", () => {
    req.get.mockReturnValue(`sha256=${"a".repeat(64)}`);

    verifyMetaWebhookSignature(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("rejects a missing signature", () => {
    req.get.mockReturnValue(undefined);

    verifyMetaWebhookSignature(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("rejects a malformed signature", () => {
    req.get.mockReturnValue("invalid-signature");

    verifyMetaWebhookSignature(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("rejects when raw body is unavailable", () => {
    req.rawBody = undefined;

    verifyMetaWebhookSignature(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test("rejects when raw body is not a Buffer", () => {
    req.rawBody = JSON.stringify({ object: "test" });

    verifyMetaWebhookSignature(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
