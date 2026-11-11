const { z } = require("zod");

const recordConsentSchema = z.object({
  studentId: z.string().uuid(),

  purpose: z.enum(["receipt", "reminder"]),

  action: z.enum(["granted", "revoked"]),

  source: z.string().trim().min(1).max(50),

  evidenceReference: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional(),
}).strict();

const studentConsentParamsSchema = z.object({
  studentId: z.string().uuid(),
}).strict();

module.exports = {
  recordConsentSchema,
  studentConsentParamsSchema,
};