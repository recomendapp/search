import { FastifyInstance } from "fastify";

interface Controller {
  register(app: FastifyInstance, prefix?: string): void;
}

export default Controller;
