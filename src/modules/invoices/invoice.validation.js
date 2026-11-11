
const { z } = require("zod");
const { toCents } = require("../payments/payment.utils");

const amountDueSchema = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/)
  .refine(
    (value) => {
      try {
        return toCents(value) > 0n;
      } catch {
        return false;
      }
    },
    { message: "Invoice amount must be greater than zero" },
  );

const createInvoiceSchema = z.object({
  studentId: z.string().uuid(),

  description: z.string()
    .trim()
    .min(1)
    .max(250),

  amountDue: amountDueSchema,

  dueDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
});

const updateInvoiceSchema = z.object({
  description: z.string().trim().min(1).max(250).optional(),

  amountDue: amountDueSchema,

  dueDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
})
.strict()
.refine(
  data => Object.keys(data).length > 0,
  { message: "At least one field is required" }
);

const invoiceListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),

  limit: z.coerce.number().int().min(1).max(100).default(20),

  status: z.enum(["active", "cancelled"]).optional(),

  studentId: z.string().uuid().optional(),

  dueFrom: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),

  dueTo: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
}).strict().refine(
  (data) => {
    if (data.dueFrom && data.dueTo) {
      return data.dueFrom <= data.dueTo;
    }

    return true;
  },
  { message: "dueFrom cannot be later than dueTo" },
);


module.exports = {
  createInvoiceSchema,
  updateInvoiceSchema,
  invoiceListQuerySchema
};
