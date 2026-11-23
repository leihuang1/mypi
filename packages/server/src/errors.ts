/** A refusal the user can act on (Ship can't run, the session is archived): HTTP 409 rather than 500. */
export class ConflictError extends Error {
  readonly status = 409;
}

/** A malformed request: HTTP 400. */
export class BadRequestError extends Error {
  readonly status = 400;
}
