
const crypto = require("crypto");
const env = require("../../config/env");

class WebhookController {
  constructor() {
    this.verifyWhatsAppWebhook =
      this.verifyWhatsAppWebhook.bind(this);
  }

  verifyWhatsAppWebhook(req, res) {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const expectedToken = env.META_WEBHOOK_VERIFY_TOKEN;

    if (!expectedToken) {
      return res.status(503).send(
        "Webhook verification is not configured",
      );
    }

    if (
      typeof mode !== "string" ||
      mode !== "subscribe" ||
      typeof token !== "string" ||
      typeof challenge !== "string"
    ) {
      return res.sendStatus(403);
    }

    const received = Buffer.from(token);
    const expected = Buffer.from(expectedToken);

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.sendStatus(403);
    }

    return res.status(200).type("text/plain").send(challenge);
  }
}

module.exports = WebhookController;
