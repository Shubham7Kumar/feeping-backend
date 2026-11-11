const AuthService = require("./auth.service");

describe("AuthService", () => {
  test("creates organization and owner", async () => {

    // Mock repository: prevents actual database operations during testing.
    const fakeRepository = {

      // jest.fn() creates a mock function.
      // mockResolvedValue() makes it return a resolved Promise.
      // Used because createOrganization() is expected to be asynchronous.
      createOrganization: jest.fn().mockResolvedValue({
        id: "org-123",
        name: "ABC Coaching",
        timezone: "Asia/Kolkata"
      }),

      // jest.fn() creates a mock function.
      // mockImplementation() lets us define custom behavior.
      // We receive client and data arguments just like the real method.
      // async makes this mock return a Promise.
      // Useful when the returned object depends on input arguments.
      createUser: jest.fn().mockImplementation(
        async (client, data) => ({
          id: "user-123",
          organization_id: data.organizationId,
          name: data.name,
          email: data.email,
          role: "owner",
          is_active: true
        })
      )
    };

    // Mock transaction manager.
    const fakeTransactionManager = {

      // jest.fn() creates a mock function.
      // The callback represents the database transaction operation.
      // We execute callback({}) to simulate passing a transaction client.
      // The async wrapper automatically returns a Promise.
      execute: jest.fn(async (callback) => {
        return callback({});
      })
    };

    // Inject mock dependencies instead of real repository/database objects.
    const service = new AuthService(
      fakeRepository,
      fakeTransactionManager
    );

    // Execute the actual service method.
    const result = await service.register({
      organizationName: "ABC Coaching",
      name: "Rahul Sharma",
      email: "RAHUL@example.com",
      password: "StrongPassword123!"
    });

    // Verify that the service normalized the email.
    expect(result.user.email).toBe("rahul@example.com");

    // Verify that the first registered user becomes organization owner.
    expect(result.user.role).toBe("owner");

    // Verify that the organization was created.
    expect(result.organization.id).toBe("org-123");

    // Verify that sensitive password hash is not exposed in the response.
    expect(result.user.password_hash).toBeUndefined();

    // Verify that the transaction manager was called exactly once.
    expect(fakeTransactionManager.execute).toHaveBeenCalledTimes(1);
  });
});