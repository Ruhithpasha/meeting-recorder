import type { FastifyError, FastifyInstance } from "fastify";
import { HttpError } from "../lib/errors.ts";

/** Maps service errors to HTTP. Unknown errors become a generic 500 (details only in the log). */
export function registerErrors(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    if ("validation" in error && error.validation) return reply.code(400).send({ error: error.message });
    if ("statusCode" in error && error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "Internal error" });
  });
}
