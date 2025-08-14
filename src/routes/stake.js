import { isValidXrplAddress } from '../services/xrplService.js';

export default async function (fastify, opts) {
  // APR info (calculated from reward_info and total staking amount)
  fastify.get('/stake/apr', async (request, reply) => {
    // Caching: APR is public data, use a fixed key
    reply.caching({ key: 'stake:apr', expiresIn: 60 * 1000 }); // 1 minute cache

    // 1. Query current active reward_info
    const [rewardRows] = await fastify.mysql.query(
      'SELECT * FROM reward_info WHERE status = "active" ORDER BY id DESC LIMIT 1'
    );
    if (rewardRows.length === 0) return { apr: 0 };

    const rewardInfo = rewardRows[0];

    // 2. Query total staking amount
    const [stakeRows] = await fastify.mysql.query(
      'SELECT SUM(staked_amount) as total_staked FROM stakes'
    );
    const totalStaked = Number(stakeRows[0]?.total_staked) || 0;

    // 3. Calculate APR
    let apr = 0;
    if (totalStaked > 0 && rewardInfo.duration > 0) {
      const yearlyReward = Number(rewardInfo.total_reward) * (365 / Number(rewardInfo.duration));
      apr = (yearlyReward / totalStaked) * 100;
    }

    return { apr: Math.floor(apr * 100) / 100 }; // Return up to 2 decimal places
  });

  // reward_info (current active)
  fastify.get('/stake/reward-info', async (request, reply) => {
    // Caching: reward_info changes infrequently, use a fixed key
    reply.caching({ key: 'stake:reward-info', expiresIn: 60 * 1000 }); // 1 minute cache

    const [rows] = await fastify.mysql.query('SELECT * FROM reward_info WHERE status = "active" ORDER BY id DESC LIMIT 1');
    return rows[0] || {};
  });

  // Total staking amount
  fastify.get('/stake/total', async (request, reply) => {
    // Caching: total staking amount changes infrequently, use a fixed key
    reply.caching({ key: 'stake:total', expiresIn: 60 * 1000 }); // 1 minute cache

    const [rows] = await fastify.mysql.query('SELECT SUM(staked_amount) as total FROM stakes');
    return { total: rows[0]?.total || 0 };
  });

  // Staking info for a specific user
  fastify.get('/stake/:account', async (request, reply) => {
    const { account } = request.params;
    if (!isValidXrplAddress(account)) {
      return reply.code(400).send({ error: 'Invalid XRPL address.' });
    }
    const [rows] = await fastify.mysql.query('SELECT * FROM stakes WHERE xrpl_address = ?', [account]);
    if (rows.length === 0) return {};
    // Remove id, last_claim_at, updated_at fields
    const { id, last_claim_at, updated_at, pocket_reward, ...rest } = rows[0];
    return rest;
  });
}