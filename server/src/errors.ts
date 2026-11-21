// An error that carries the HTTP status to answer with.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
