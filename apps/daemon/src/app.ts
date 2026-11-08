import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger } from "fastify";
import type { Container } from "./container.ts";
import { registerErrors } from "./plugins/errors.ts";
import { registerSecurity } from "./plugins/security.ts";
import { registerRoutes } from "./routes/index.ts";

export interface AppOptions {
  container: Container;
  token: string;
  /** Port the server listens on; read lazily for the Host check (known only after listen). */
  port: () => number;
  /** Built dashboard (apps/web/dist). */
  webDist: string;
  /** Shared pino logger (file-backed in production). Omit for silent tests. */
  loggerInstance?: FastifyBaseLogger;
}

export async function buildApp(o: AppOptions) {
  const app = Fastify({
    ...(o.loggerInstance ? { loggerInstance: o.loggerInstance } : { logger: false }),
    bodyLimit: 64 * 1024,
    return503OnClosing: true,
    // Close every socket on shutdown, including dashboard SSE streams that never end on their own;
    // otherwise close() waits forever while a dashboard tab is open and the daemon is orphaned.
    forceCloseConnections: true,
    // Reject unknown fields (additionalProperties: false) instead of silently stripping them.
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(fastifyCookie);
  registerSecurity(app, { token: o.token, port: o.port });
  registerErrors(app);

  // Dashboard assets. Hashed asset names are immutable; index.html must always be revalidated.
  await app.register(fastifyStatic, {
    root: o.webDist,
    prefix: "/",
    index: "index.html",
    cacheControl: false,
    setHeaders: (res, path) => {
      res.header("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });
  await registerRoutes(app, o.container, o.token);

  // Client-side routes fall back to the SPA shell; unknown API paths stay JSON 404s.
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });

  return app;
}
