class InvoiceController {
  constructor(invoiceService) {
    this.invoiceService = invoiceService;

    this.createInvoice = this.createInvoice.bind(this);
    this.getInvoices = this.getInvoices.bind(this);
    this.getInvoiceById = this.getInvoiceById.bind(this);
    this.updateInvoice = this.updateInvoice.bind(this);
    this.cancelInvoice = this.cancelInvoice.bind(this);
  }

  async createInvoice(req, res, next) {
    try {
      const invoice = await this.invoiceService.createInvoice(
        req.validatedBody,
        req.user,
      );

      return res.status(201).json({
        success: true,
        message: "Invoice created successfully",
        data: { invoice },
      });
    } catch (error) {
      next(error);
    }
  }

async getInvoices(req, res, next) {
  try {
    const result = await this.invoiceService.getInvoices(
      req.user.organizationId,
      req.validatedQuery,
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

  async getInvoiceById(req, res, next) {
    try {
      const invoice = await this.invoiceService.getInvoiceById(
        req.params.id,
        req.user.organizationId,
      );

      return res.status(200).json({
        success: true,
        data: { invoice },
      });
    } catch (error) {
      next(error);
    }
  }

  async updateInvoice(req, res, next) {
    try {
      const invoice = await this.invoiceService.updateInvoice(
        req.params.id,
        req.validatedBody,
        req.user,
      );

      res.status(200).json({
        success: true,
        message: "Invoice updated successfully",
        data: invoice,
      });
    } catch (error) {
      next(error);
    }
  }

  async cancelInvoice(req, res, next) {
    try {
      const invoice = await this.invoiceService.cancelInvoice(
        req.params.id,
        req.user,
      );

      res.status(200).json({
        success: true,
        message: "Invoice cancelled successfully",
        data: invoice,
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = InvoiceController;
