
const { z } = require("zod");

const createPaymentSchema = z
  .object({
    invoiceId: z.string().uuid(),

    // Keep money as a string to avoid floating-point precision issues.
    amount: z
      .string()
      .regex(
        /^\d{1,10}(\.\d{1,2})?$/,
        "Amount must have at most 10 whole digits and 2 decimal places"
      )
      .refine((value) => /[1-9]/.test(value), {
        message: "Amount must be greater than zero",
      }),

    paymentMethod: z.enum(["cash", "upi", "bank_transfer"]),

    receivedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

module.exports = {
  createPaymentSchema,
};
