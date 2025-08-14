import { isValidXrplAddress } from '../services/xrplService.js';

export default async function (fastify, opts) {
  // request.params: limit, offset, tx_type
  fastify.get('/history/:account', async (request, reply) => {
    const { account } = request.params;
    if (!isValidXrplAddress(account)) {
      return reply.code(400).send({ error: '유효하지 않은 XRPL 주소입니다.' });
    }
    const { limit = 20, offset = 0, tx_type } = request.query;

    let query = `SELECT * FROM transactions WHERE xrpl_address = ?`;
    const params = [account];

    if (tx_type) {
      query += ` AND UPPER(tx_type) = UPPER(?)`;
      params.push(tx_type);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const [rows] = await fastify.mysql.query(query, params);
    // id 필드 제외
    return rows.map(({ id, ...rest }) => rest);
  });
}