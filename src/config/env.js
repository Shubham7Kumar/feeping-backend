const { z } = require("zod");
require("dotenv").config();

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]),

    PORT: z.coerce.number().int().positive().default(5000),

    DATABASE_URL: z.string().min(1),
    TEST_DATABASE_URL: z.string().url().optional(),

    FRONTEND_URL: z.string().url(),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),

    // WhatsApp provider configuration
    WHATSAPP_PROVIDER: z.enum(["mock", "meta"]).default("mock"),

    META_PHONE_NUMBER_ID: z.string().min(1).optional(),
    META_ACCESS_TOKEN: z.string().min(1).optional(),
    META_APP_SECRET: z.string().min(1).optional(),
    META_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
    META_API_VERSION: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .optional(),

    WHATSAPP_RECEIPT_TEMPLATE_NAME: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .optional(),

    WHATSAPP_TEMPLATE_LANGUAGE: z.string().min(2).default("en_IN"),
  })
  .superRefine((values, ctx) => {
    if (values.WHATSAPP_PROVIDER === "meta") {
      const requiredFields = [
        "META_PHONE_NUMBER_ID",
        "META_ACCESS_TOKEN",
        "META_API_VERSION",
        "WHATSAPP_RECEIPT_TEMPLATE_NAME",
      ];

      for (const field of requiredFields) {
        if (!values[field]) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is required when WHATSAPP_PROVIDER is meta`,
          });
        }
      }
    }

    // Webhook configuration is independent of sending provider.
    if (
      Boolean(values.META_APP_SECRET) !==
      Boolean(values.META_WEBHOOK_VERIFY_TOKEN)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["META_WEBHOOK_VERIFY_TOKEN"],
        message:
          "META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN must be configured together",
      });
    }
  });

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("Invalid environment configuration:");
  console.error(result.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = result.data;
