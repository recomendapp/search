import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Controller from '../../interfaces/controller.interface';

class HelloController implements Controller {
  register(app: FastifyInstance, prefix = ''): void {
    app.get(`${prefix}/`, async (req: FastifyRequest, reply: FastifyReply) => {
      return { message: 'Hello World' };
    });
  }
}

export default HelloController;