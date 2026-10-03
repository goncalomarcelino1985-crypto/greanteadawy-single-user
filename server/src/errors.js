/** Error with an HTTP status code (used by the API error handler). */
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Express helper: forward async handler errors to the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
