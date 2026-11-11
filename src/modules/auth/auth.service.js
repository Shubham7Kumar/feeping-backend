const bcrypt = require("bcryptjs");
const AppError = require("../../shared/errors/AppError");
const { generateAccessToken } = require("../../shared/utils/token");

class AuthService {
  constructor(authRepository, transactionManager) {
    this.authRepository = authRepository;
    this.transactionManager = transactionManager;
  }

  async register(data) {
    const organizationName = data.organizationName.trim();
    const name = data.name.trim();
    const email = data.email.trim().toLowerCase();
    const password = data.password;

    // Bcrypt supports a maximum of 72 bytes.
    if (Buffer.byteLength(password, "utf8") > 72) {
      throw new AppError(
        "Password cannot exceed 72 bytes",
        400,
        "PASSWORD_TOO_LONG",
      );
    }

    // Hash password before opening the DB transaction.
    const passwordHash = await bcrypt.hash(password, 12);

    try {
      return await this.transactionManager.execute(async (client) => {
        const organization = await this.authRepository.createOrganization(
          client,
          organizationName,
        );

        const user = await this.authRepository.createUser(client, {
          organizationId: organization.id,
          name,
          email,
          passwordHash,
        });

        return {
          organization: {
            id: organization.id,
            name: organization.name,
            timezone: organization.timezone,
          },
          user,
        };
      });
    } catch (error) {
      if (error.code === "23505") {
        throw new AppError(
          "An account with this email already exists",
          409,
          "EMAIL_ALREADY_EXISTS",
        );
      }

      throw error;
    }
  }

  async login(data) {
    const email = data.email.trim().toLowerCase();

    const user = await this.authRepository.findUserByEmail(email);

    // Use a generic error to avoid revealing whether an email exists.
    if (!user || !user.is_active) {
      throw new AppError(
        "Invalid email or password",
        401,
        "INVALID_CREDENTIALS",
      );
    }

    const passwordMatches = await bcrypt.compare(
      data.password,
      user.password_hash,
    );

    if (!passwordMatches) {
      throw new AppError(
        "Invalid email or password",
        401,
        "INVALID_CREDENTIALS",
      );
    }

    const accessToken = generateAccessToken(user);

    const { password_hash, ...safeUser } = user;

    return {
      user: safeUser,
      accessToken,
    };
  }
  async getCurrentUser(userId) {
    const user = await this.authRepository.findActiveUserById(userId);

    if (!user) {
      throw new AppError(
        "User account is unavailable",
        401,
        "USER_NOT_AVAILABLE",
      );
    }

    return user;
  }
}

module.exports = AuthService;
