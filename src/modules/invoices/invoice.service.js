const AppError = require("../../shared/errors/AppError");
const { normalizeMoney, toCents } = require("../payments/payment.utils");

class InvoiceService {
  constructor(invoiceRepository, studentRepository, transactionManager) {
    this.invoiceRepository = invoiceRepository;
    this.studentRepository = studentRepository;
    this.transactionManager = transactionManager;
  }

  async createInvoice(data, user) {
    const organizationId = user?.organizationId;
    const createdBy = user?.id;

    if (!organizationId || !createdBy) {
      throw new AppError("Invalid user context", 401);
    }

    const { studentId, description, amountDue, dueDate } = data;

    if (!studentId) {
      throw new AppError("Student ID is required", 400);
    }

    if (
      typeof description !== "string" ||
      description.trim().length < 1 ||
      description.trim().length > 250
    ) {
      throw new AppError("Invalid invoice description", 400);
    }

    if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(amountDue))) {
      throw new AppError("Invalid invoice amount", 400);
    }

    if (toCents(amountDue) <= 0n) {
      throw new AppError("Invoice amount must be greater than zero", 400);
    }

    if (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      throw new AppError("Invalid due date", 400);
    }

    const parsedDate = new Date(`${dueDate}T00:00:00.000Z`);

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== dueDate
    ) {
      throw new AppError("Invalid calendar date", 400);
    }

    return this.transactionManager.execute(async (client) => {
      const student = await this.studentRepository.findByIdForUpdate(
        studentId,
        organizationId,
        client,
      );

      if (!student) {
        throw new AppError("Student not found", 404);
      }

      if (!student.is_active) {
        throw new AppError("Cannot create invoice for inactive student", 422);
      }

      return this.invoiceRepository.create(
        {
          organizationId,
          studentId,
          description: description.trim(),
          amountDue: normalizeMoney(amountDue),
          dueDate,
          createdBy,
        },
        client,
      );
    });
  }

  async getInvoices(organizationId, filters = {}) {
    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    return this.invoiceRepository.findAll(organizationId, filters);
  }

  async getInvoiceById(id, organizationId) {
    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    const invoice = await this.invoiceRepository.findById(id, organizationId);

    if (!invoice) {
      throw new AppError("Invoice not found", 404, "INVOICE_NOT_FOUND");
    }

    return invoice;
  }

  async updateInvoice(id, data, user) {
    const organizationId = user?.organizationId;

    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    return this.transactionManager.execute(async (client) => {
      const invoice = await this.invoiceRepository.findByIdForUpdate(
        id,
        organizationId,
        client,
      );

      if (!invoice) {
        throw new AppError("Invoice not found", 404, "INVOICE_NOT_FOUND");
      }

      if (invoice.lifecycle_status !== "active") {
        throw new AppError(
          "Cancelled invoices cannot be updated",
          409,
          "INVOICE_ALREADY_CANCELLED",
        );
      }

      if (data.amountDue !== undefined) {
        const hasPayments = await this.invoiceRepository.hasPaymentHistory(
          id,
          organizationId,
          client,
        );

        if (hasPayments) {
          throw new AppError(
            "Invoice amount cannot be changed after payment history exists",
            409,
            "INVOICE_HAS_PAYMENT_HISTORY",
          );
        }
      }

      const updateFields = { ...data };

      if (updateFields.amountDue !== undefined) {
        if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(updateFields.amountDue))) {
          throw new AppError("Invalid invoice amount", 400);
        }

        if (toCents(updateFields.amountDue) <= 0n) {
          throw new AppError("Invoice amount must be greater than zero", 400);
        }

        updateFields.amountDue = normalizeMoney(updateFields.amountDue);
      }

      if (updateFields.description !== undefined) {
        updateFields.description = updateFields.description.trim();
      }

      return this.invoiceRepository.update(
        id,
        organizationId,
        updateFields,
        client,
      );
    });
  }

  async cancelInvoice(id, user) {
    const organizationId = user?.organizationId;

    if (!organizationId) {
      throw new AppError(
        "Organization context is required",
        401,
        "ORGANIZATION_CONTEXT_REQUIRED",
      );
    }

    return this.transactionManager.execute(async (client) => {
      const invoice = await this.invoiceRepository.findByIdForUpdate(
        id,
        organizationId,
        client,
      );

      if (!invoice) {
        throw new AppError("Invoice not found", 404, "INVOICE_NOT_FOUND");
      }

      if (invoice.lifecycle_status !== "active") {
        throw new AppError(
          "Invoice is already cancelled",
          409,
          "INVOICE_ALREADY_CANCELLED",
        );
      }

      return this.invoiceRepository.cancel(id, organizationId, client);
    });
  }
}

module.exports = InvoiceService;
