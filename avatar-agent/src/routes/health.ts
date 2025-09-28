import { FastifyInstance } from "fastify";

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/healthz", async () => ({ ok: true, ts: Date.now() }));
}


