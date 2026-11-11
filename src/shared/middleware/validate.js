
function validate(schema, source = "body") {
  const allowedSources = ["body", "query", "params"];

  if (!allowedSources.includes(source)) {
    throw new Error(`Unsupported validation source: ${source}`);
  }

  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: result.error.flatten().fieldErrors,
      });
    }

    if (source === "body") {
      req.validatedBody = result.data;
    } else if (source === "query") {
      req.validatedQuery = result.data;
    } else {
      req.validatedParams = result.data;
    }

    next();
  };
}

module.exports = validate;


/**
 Q. Why safeParse()?

 * It returns a result indicating whether validation succeeded, instead of requiring us to catch a validation exception.

 * If validation fails, the middleware sends a 400 response. If it succeeds, it stores the validated input in req.validatedBody.

 * This also means our controller can use the validated data rather than blindly trusting req.body.
 */