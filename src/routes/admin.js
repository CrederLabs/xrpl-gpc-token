import { rolloverRewardPool } from '../services/transactionHandler.js';

export default async function (fastify, opts) {
  fastify.post('/admin/reward/rollover', async (request, reply) => {
    if (!request.headers['x-admin-key'] || request.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { type = 'end' } = request.body || {};
    if (type !== 'end' && type !== 'snapshot') {
      return reply.code(400).send({ error: 'Invalid type. Use "end" or "snapshot".' });
    }
    try {
      const result = await rolloverRewardPool(fastify, { type });
      return { success: true, ...result };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
