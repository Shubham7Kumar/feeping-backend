const AppError = require("../errors/AppError");

function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(
        new AppError("Authentication required", 401, "AUTHENTICATION_REQUIRED")
      );
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError("You do not have permission", 403, "FORBIDDEN")
      );
    }

    next();
  };
}

module.exports = authorize;