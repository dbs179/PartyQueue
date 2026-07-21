/**
 * Wrap async Express handlers so rejected promises become JSON errors
 * instead of hanging the request.
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => unknown} fn
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (res.headersSent) return next(err);
      const status = Number(err?.statusCode || err?.status) || 500;
      const safe =
        Number.isFinite(status) && status >= 400 && status < 600 ? status : 500;
      res.status(safe).json({
        error: err?.message || "Internal server error.",
      });
    });
  };
}
