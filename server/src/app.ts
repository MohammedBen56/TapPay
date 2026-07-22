import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import sensible from "@fastify/sensible";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(sensible);

  app.get("/health", async () => ({ status: "ok" }));

  // Errors are typed and surfaced, never swallowed (CLAUDE.md §8): logs the full
  // error server-side and returns a structured body, rather than Fastify's bare
  // default response or a silent 500 with no detail.
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: error.name || "InternalError",
      message: error.message,
    });
  });

  return app;
}
