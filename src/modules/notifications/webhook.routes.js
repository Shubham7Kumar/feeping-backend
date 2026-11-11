
const express = require("express");

function createWebhookRoutes(webhookController) {
  const router = express.Router();

  router.get(
    "/whatsapp",
    webhookController.verifyWhatsAppWebhook,
  );

  return router;
}

module.exports = createWebhookRoutes;
