const express = require("express");
const authorize = require("../../shared/middleware/authorize");
const validate = require("../../shared/middleware/validate");
const {
  createInvoiceSchema,
  updateInvoiceSchema,
  invoiceListQuerySchema,
} = require("./invoice.validation");

function createInvoiceRoutes(invoiceController, authenticate) {
  const router = express.Router();

  router.use(authenticate);

  router.post(
    "/",
    authorize("owner", "admin"),
    validate(createInvoiceSchema),
    invoiceController.createInvoice,
  );

  router.get(
    "/",
    authorize("owner", "admin"),
    validate(invoiceListQuerySchema, "query"),
    invoiceController.getInvoices,
  );

  router.get(
    "/:id",
    authorize("owner", "admin"),
    invoiceController.getInvoiceById,
  );

  router.patch(
    "/:id",
    authorize("owner", "admin"),
    validate(updateInvoiceSchema),
    invoiceController.updateInvoice,
  );

  router.post(
    "/:id/cancel",
    authorize("owner", "admin"),
    invoiceController.cancelInvoice,
  );

  return router;
}

module.exports = createInvoiceRoutes;
