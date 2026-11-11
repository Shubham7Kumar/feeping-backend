const AppError = require("../errors/AppError");
const { verifyAccessToken } = require("../utils/token");

function createAuthenticate(authRepository) {
  return async function authenticate(req, res, next) {
    try {
      const token = req.cookies?.accessToken;

      if (!token) {
        throw new AppError(
          "Authentication required",
          401,
          "AUTHENTICATION_REQUIRED"
        );
      }

      const decoded = verifyAccessToken(token);

      const user = await authRepository.findActiveUserById(
        decoded.sub
      );

      if (!user) {
        throw new AppError(
          "User account is unavailable",
          401,
          "USER_NOT_AVAILABLE"
        );
      }

      req.user = {
        id: user.id,
        organizationId: user.organization_id,
        name: user.name,
        email: user.email,
        role: user.role
      };

      next();
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }

      if (
        error.name === "JsonWebTokenError" ||
        error.name === "TokenExpiredError"
      ) {
        return next(
          new AppError(
            "Invalid or expired access token",
            401,
            "INVALID_ACCESS_TOKEN"
          )
        );
      }

      next(error);
    }
  };
}

module.exports = createAuthenticate;