/**
 * Domain errors with an HTTP status. Services throw these; the HTTP layer maps
 * them to `{error:{code,message}}` (400 validation, 404, 409 conflict, …).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string): AppError => new AppError(400, "validation_error", message);
export const notFound = (what: string, id?: string): AppError => new AppError(404, "not_found", id ? `${what} ${id} not found` : `${what} not found`);
export const conflict = (message: string): AppError => new AppError(409, "conflict", message);
export const unauthorized = (): AppError => new AppError(401, "unauthorized", "Missing or invalid bearer token");
