
const express = require("express");

const { createPaymentSchema } = require("./payment.validation");
const validate = require("../../shared/middleware/validate");
const authorize = require("../../shared/middleware/authorize");

function createPaymentRoutes(paymentController, authenticate) {
  const router = express.Router();

  router.post(
    "/",
    authenticate,
    authorize("owner", "admin"),
    validate(createPaymentSchema),
    paymentController.create.bind(paymentController)
  );

  return router;
}

module.exports = createPaymentRoutes;
