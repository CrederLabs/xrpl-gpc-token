import { isValidXrplAddress } from '../services/xrplService.js';
import { getExchangeRate } from '../config/exchangeRate.js';

export default async function (fastify, opts) {
  // Get exchange rate (table and column names updated)
  fastify.get('/swap/rate', async (request, reply) => {
    // swap_type is received as a query parameter (e.g., /swap/rate?swap_type=RLUSD_GPC)
    const { swap_type } = request.query;
    if (!swap_type) {
      return reply.code(400).send({ error: 'swap_type parameter is required.' });
    }
    const rateResult = await getExchangeRate(swap_type);
    if (!rateResult) return { rate: null };
    return { rate: rateResult };
  });

  // Remaining GPC supply in Swap Pool: should be queried directly from XRPL address by frontend

  // Get swap fee
  fastify.get('/swap/fee', async (request, reply) => {
    // Fee for GPC and RLUSD is set to 0.05
    return { fee: 0.05 };
  });

  // Get recent swap_requests status (within 5 minutes)
  fastify.get('/swap/status/:account', async (request, reply) => {
    const { account } = request.params;
    // Validate account (XRPL address format)
    if (!isValidXrplAddress(account)) {
      return reply.code(400).send({ error: 'Invalid XRPL address.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const [rows] = await fastify.mysql.query(
      `SELECT * FROM swap_requests WHERE account = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
      [account, now - 300]
    );
    if (rows.length === 0) return { status: 'none' };
    return { status: rows[0].status, fail_reason: rows[0].fail_reason };
  });
}