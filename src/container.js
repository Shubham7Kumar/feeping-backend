const pool = require("./infrastructure/database/pool");
const TransactionManager = require("./infrastructure/database/TransactionManager");
const AuditRepository = require("./modules/audit/audit.repository");
const AuthController = require("./modules/auth/auth.controller");
const AuthRepository = require("./modules/auth/auth.repository");
const createAuthRoutes = require("./modules/auth/auth.routes");
const AuthService = require("./modules/auth/auth.service");
const InvoiceController = require("./modules/invoices/invoice.controller");
const InvoiceRepository = require("./modules/invoices/invoice.repository");
const createInvoiceRoutes = require("./modules/invoices/invoice.routes");
const InvoiceService = require("./modules/invoices/invoice.service");
const ConsentController = require("./modules/notifications/consent.controller");
const ConsentRepository = require("./modules/notifications/consent.repository");
const createConsentRoutes = require("./modules/notifications/consent.routes");
const ConsentService = require("./modules/notifications/consent.service");
const MessageRepository = require("./modules/notifications/message.repository");
const PaymentController = require("./modules/payments/payment.controller");
const PaymentRepository = require("./modules/payments/payment.repository");
const createPaymentRoutes = require("./modules/payments/payment.routes");
const PaymentService = require("./modules/payments/payment.service");
const StudentController = require("./modules/students/student.controller");
const StudentRepository = require("./modules/students/student.repository");
const createStudentRoutes = require("./modules/students/student.routes");
const StudentService = require("./modules/students/student.service");
const createAuthenticate = require("./shared/middleware/authenticate");
const WebhookController = require("./modules/notifications/webhook.controller");
const createWebhookRoutes = require("./modules/notifications/webhook.routes");

const authRepository = new AuthRepository(pool);
const studentRepository = new StudentRepository(pool);
const auditRepository = new AuditRepository(pool);
const consentRepository = new ConsentRepository(pool);
const paymentRepository = new PaymentRepository(pool);
const transactionManager = new TransactionManager(pool);
const invoiceRepository = new InvoiceRepository(pool);
const messageRepository = new MessageRepository(pool);
const authenticate = createAuthenticate(authRepository);

const studentService = new StudentService(
  studentRepository,
  transactionManager,
);
const studentController = new StudentController(studentService);
const studentRoutes = createStudentRoutes(studentController, authenticate);

const authService = new AuthService(authRepository, transactionManager);
const authController = new AuthController(authService);
const authRoutes = createAuthRoutes(authController, authenticate);


const invoiceService = new InvoiceService(
  invoiceRepository,
  studentRepository,
  transactionManager,
);
const invoiceController = new InvoiceController(invoiceService);
const invoiceRoutes = createInvoiceRoutes(invoiceController, authenticate);

const paymentService = new PaymentService(
  paymentRepository,
  auditRepository,
  consentRepository,
  studentRepository,
  transactionManager,
  messageRepository,
);
const paymentController = new PaymentController(paymentService);
const paymentRoutes = createPaymentRoutes(paymentController, authenticate);

const consentService = new ConsentService(
  consentRepository,
  studentRepository,
  auditRepository,
  transactionManager,
);

const consentController = new ConsentController(consentService);

const consentRoutes = createConsentRoutes(consentController, authenticate);

const webhookController = new WebhookController();
const webhookRoutes = createWebhookRoutes(webhookController);

module.exports = {
  pool,
  studentRepository,
  studentService,
  studentController,
  studentRoutes,
  authRepository,
  transactionManager,
  authService,
  authController,
  authRoutes,
  invoiceRepository,
  invoiceService,
  invoiceController,
  invoiceRoutes,
  paymentRepository,
  paymentService,
  paymentController,
  paymentRoutes,
  auditRepository,
  consentRepository,
  consentService,
  consentController,
  consentRoutes,
  messageRepository,
  webhookController,
  webhookRoutes,
};
