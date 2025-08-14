import { isValidXrplAddress } from '../services/xrplService.js';

export default async function (fastify, opts) {
  // Amount of GPC available for unstaking
  fastify.get('/unstake/amount/:account', async (request, reply) => {
    const { account } = request.params;
    // Validate account (XRPL address format)
    if (!isValidXrplAddress(account)) {
      return reply.code(400).send({ error: 'Invalid XRPL address.' });
    }
    const [rows] = await fastify.mysql.query('SELECT staked_amount FROM stakes WHERE xrpl_address = ?', [account]);
    return { unstakeable: rows[0]?.staked_amount || 0 };
  });

  // Get recent unstake_requests status (within 5 minutes)
  fastify.get('/unstake/status/:account', async (request, reply) => {
    const { account } = request.params;
    // Validate account (XRPL address format)
    if (!isValidXrplAddress(account)) {
      return reply.code(400).send({ error: 'Invalid XRPL address.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const [rows] = await fastify.mysql.query(
      `SELECT * FROM unstake_requests WHERE account = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
      [account, now - 300]
    );
    if (rows.length === 0) return { status: 'none' };
    return { status: rows[0].status, fail_reason: rows[0].fail_reason };
  });
}