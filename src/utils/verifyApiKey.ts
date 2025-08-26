import { onRequestHookHandler } from "fastify";

export const verifyApiKey: onRequestHookHandler = async (request, reply) => {
	if (request.headers.authorization) {
		try {
			await request.jwtVerify();
		} catch (err) {
			reply.send(err);
		}
	}
};