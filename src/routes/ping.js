export default async function (fastify, opts) {
  fastify.get('/ping', async (request, reply) => {
    return { pong: true };
  });
}
