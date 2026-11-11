
const crypto = require("crypto");
const env = require("../../config/env");

function verifyMetaWebhookSignature(req, res, next) {
  const signature = req.get("x-hub-signature-256");

  if (!env.META_APP_SECRET) {
    return res.status(503).json({
      success: false,
      message: "Webhook signature verification is not configured",
    });
  }

  if (!Buffer.isBuffer(req.rawBody)) {
    return res.status(400).json({
      success: false,
      message: "Raw request body is unavailable",
    });
  }

  if (
    typeof signature !== "string" ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature)
  ) {
    return res.status(401).json({
      success: false,
      message: "Invalid webhook signature",
    });
  }

  const receivedSignature = Buffer.from(signature.slice(7), "hex");

  const expectedSignature = crypto
    .createHmac("sha256", env.META_APP_SECRET)
    .update(req.rawBody)
    .digest();

  const isValid = crypto.timingSafeEqual(
    receivedSignature,
    expectedSignature
  );

  if (!isValid) {
    return res.status(401).json({
      success: false,
      message: "Invalid webhook signature",
    });
  }

  next();
}

module.exports = verifyMetaWebhookSignature;

/**
 * Step 2 — WHY this implementation?
 * Component	          Purpose
 * createHmac()	        SHA-256 HMAC calculate karta hai
 * req.rawBody	        Original request bytes verify karta hai
 * timingSafeEqual()	  Timing-based comparison attacks se protection
 * 401	                Invalid signature reject
 * 503	                Server configuration missing
 *
 * Meta ka X-Hub-Signature-256 header META_APP_SECRET se verify hota hai, WhatsApp access token se nahi.
 */