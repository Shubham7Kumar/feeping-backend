const { z } = require("zod");

const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(150),
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(255),
  password: z.string().min(12).max(72)
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(72)
});

module.exports = {
  registerSchema,
  loginSchema
};