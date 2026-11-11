const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const env = require("./config/env");
const pool = require("./infrastructure/database/pool");
const errorHandler = require("./shared/middleware/errorHandler");
const { authRoutes, studentRoutes, invoiceRoutes, paymentRoutes, consentRoutes, webhookRoutes } = require("./container");

const app = express();

app.use(helmet());

app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true
}));

app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buffer) => {
      if (req.originalUrl.startsWith("/api/v1/webhooks/whatsapp")) {
        req.rawBody = Buffer.from(buffer);
      }
    },
  })
);
app.use(cookieParser());

app.get("/api/v1/health",async(req,res) => {
    try {
        await pool.query("SELECT 1");

        res.status(200).json({
            success: true,
            message: 'FeePing API is healthy',
            database: 'connected'
        })
    } catch (error) {
        res.status(503).json({
            success: false,
            message: "Database unavailable"
        });
    }
});

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/students", studentRoutes);
app.use("/api/v1/invoices",invoiceRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/consents", consentRoutes);
app.use("/api/v1/webhooks", webhookRoutes);

app.use(errorHandler);

module.exports = app;