export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details)
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`)
export const conflict = (message) => new HttpError(409, 'conflict', message)
export const tooMany = (message, details) => new HttpError(429, 'rate_limited', message, details)
export const unauthorized = (message = 'Unauthorized') => new HttpError(401, 'unauthorized', message)
