const { z } = require("zod");

const createStudentSchema = z.object({
  name: z.string().trim().min(1).max(150),

  admissionNumber: z.string().trim().max(50).optional(),

  parentName: z.string().trim().max(150).optional(),

  parentWhatsapp: z.string().trim().max(20).optional(),
});

const studentListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),

    limit: z.coerce.number().int().min(1).max(100).default(20),

    search: z.string().trim().max(100).optional(),

    status: z.enum(["active", "inactive"]).optional(),
  })
  .strict();

const updateStudentSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),

    admissionNumber: z.string().trim().max(80).nullable().optional(),

    parentName: z.string().trim().max(150).nullable().optional(),

    parentWhatsapp: z.string().trim().max(20).nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  });

const studentIdParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

const updateStudentStatusSchema = z
  .object({
    isActive: z.boolean(),
  })
  .strict();

module.exports = {
  createStudentSchema,
  studentListQuerySchema,
  updateStudentSchema,
  studentIdParamsSchema,
  updateStudentStatusSchema
};
