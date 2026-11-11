
const express = require("express");

const validate = require("../../shared/middleware/validate");

const {
  registerSchema,
  loginSchema
} = require("./auth.validation");

function createAuthRoutes(authController,authenticate) {
  const router = express.Router();

  router.post(
    "/register",
    validate(registerSchema),
    authController.register
  );

  router.post(
    "/login",
    validate(loginSchema),
    authController.login
  );

  router.post(
    "/logout",
    authController.logout
  );

  router.get(
    "/me",
    authenticate,
    authController.me
  );

  return router;
}

module.exports = createAuthRoutes;
