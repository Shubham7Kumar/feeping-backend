
const crypto = require("crypto");

/**
 * Converts a monetary amount into the smallest currency unit (paise/cents).
 *
 * Why?
 * JavaScript floating-point numbers can introduce precision errors
 * during financial calculations. Using BigInt ensures exact arithmetic.
 *
 * Examples:
 * toCents("6500.50") -> 650050n
 * toCents("100.25")  -> 10025n
 * toCents("-500.00") -> -50000n
 */
function toCents(value) {
  // Validate the monetary value: optional negative sign, whole number,
  // and an optional decimal portion containing up to two digits.
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(
    String(value)
  );

  // Reject invalid monetary formats before performing calculations.
  if (!match) {
    throw new Error("Invalid monetary value");
  }

  // Extract the whole-number portion and convert it to BigInt.
  const whole = BigInt(match[2]);

  // Normalize the fractional portion to exactly two digits.
  // Example: "5" becomes "50", representing 50 paise.
  const fraction = BigInt((match[3] || "").padEnd(2, "0"));

  // Convert rupees into paise and add the fractional paise.
  // BigInt ensures that the calculation remains precise.
  const cents = whole * 100n + fraction;

  // Preserve the original negative sign, if present.
  return match[1] === "-" ? -cents : cents;
}

/**
 * Generates a SHA-256 fingerprint for a payment request.
 *
 * Why?
 * The fingerprint helps identify whether an incoming request
 * contains the same payment data as a previously processed request.
 *
 * It supports idempotency by detecting when the same idempotency key
 * is reused with different payment details.
 *
 * Same payment data     -> Same fingerprint
 * Different payment data -> Different fingerprint (with overwhelming probability)
 */
function createRequestFingerprint({
  invoiceId,
  amount,
  paymentMethod,
  receivedAt
}) {
  // Create a consistent JSON representation of the payment details.
  // Convert amount to a string to avoid number/string representation differences.
  const normalizedPayload = JSON.stringify({
    invoiceId,
    amount: String(amount),
    paymentMethod,
    receivedAt
  });

  // Generate a SHA-256 hash of the payment payload.
  // Hexadecimal encoding produces a 64-character fingerprint.
  return crypto
    .createHash("sha256")
    .update(normalizedPayload)
    .digest("hex");
}


function normalizeMoney(value) {
  const [whole, fraction = ""] = String(value).split(".");

  const normalizedWhole = BigInt(whole).toString();
  const normalizedFraction = fraction.padEnd(2, "0");

  return `${normalizedWhole}.${normalizedFraction}`;
}

function fromCents(cents) {
  const isNegative = cents < 0n;
  const absolute = isNegative ? -cents : cents;

  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");

  return `${isNegative ? "-" : ""}${whole}.${fraction}`;
}


// Export utility functions so they can be reused across payment modules.
module.exports = {
  toCents,
  createRequestFingerprint,
  normalizeMoney,
  fromCents
};
