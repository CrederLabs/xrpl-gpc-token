// routes/reward.js
import { getUserAccumulatedReward } from '../services/transactionHandler.js';
import { isValidXrplAddress } from '../services/xrplService.js';

export default async function (fastify, opts) {
    fastify.get('/reward/:xrpl_address', async (request, reply) => {
        const { xrpl_address } = request.params;
        
        if (!isValidXrplAddress(xrpl_address)) {
            return reply.code(400).send({ error: '유효하지 않은 XRPL 주소입니다.' });
        }

        if (!xrpl_address) {
            return reply.code(400).send({ error: 'xrpl_address required' });
        }
        try {
            const reward = await getUserAccumulatedReward(fastify, xrpl_address);
            return { xrpl_address, reward };
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to get reward' });
        }
    });
}
