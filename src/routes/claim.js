import { getUserAccumulatedReward } from '../services/transactionHandler.js';
import { isValidXrplAddress } from '../services/xrplService.js';

export default async function (fastify, opts) {
  // Claimable RLUSD amount
  fastify.get('/claim/amount/:account', async (request, reply) => {
    const { account } = request.params;

    // Validate account (XRPL address format)
    if (!isValidXrplAddress(account)) {
      return reply.code(400).send({ error: 'Invalid XRPL address.' });
    }

    // Apply cache key per account
    reply.caching({ key: `claimable:${account}`, expiresIn: 60 * 1000 }); // 1 minute cache

    const amount = await getUserAccumulatedReward(fastify, account);
    return { claimable: amount };
  });

  // Get recent claim_requests status (within 5 minutes)
  fastify.get('/claim/status/:account', async (request, reply) => {
    const { account } = request.params;

    // Validate account (XRPL address format)
    if (!isValidXrplAddress(account)) {
      return reply.code(400).send({ error: 'Invalid XRPL address.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const [rows] = await fastify.mysql.query(
      `SELECT * FROM claim_requests WHERE account = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
      [account, now - 300]
    );
    if (rows.length === 0) return { status: 'none' };
    return { status: rows[0].status, fail_reason: rows[0].fail_reason };
  });
}