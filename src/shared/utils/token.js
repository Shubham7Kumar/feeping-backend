const jwt = require("jsonwebtoken");
const env = require("../../config/env");

function generateAccessToken(user) {
  const token = jwt.sign   (
    {
      sub: user.id,
      organizationId: user.organization_id,
      role: user.role,
    },
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
      issuer: "feeping-api",
      audience: "feeping-client",
    },
  );
  return token
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: "feeping-api",
    audience: "feeping-client"
  });
}

module.exports = {
  generateAccessToken,
  verifyAccessToken
};
