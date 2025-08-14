// src/routes/signature.js
// Xaman(XUMM) SDK based signature request/verification API

import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { getUserAccumulatedReward } from '../services/transactionHandler.js';
import { isValidXrplAddress } from '../services/xrplService.js';

export default async function (fastify, opts) {
  const XUMM_API_KEY = process.env.XUMM_API_KEY;
  const XUMM_API_SECRET = process.env.XUMM_API_SECRET;

  // 1. Signature request API
  fastify.post('/request-signature', async (request, reply) => {
    try {
      let { userAccount, action, userToken, amount } = request.body;
      
      if (!userAccount || !action) {
        return reply.code(400).send({ error: 'userAccount and action are required' });
      }

      if (!isValidXrplAddress(userAccount)) {
        return reply.code(400).send({ error: 'Invalid XRPL address.' });
      }

      if (!userAccount || !['unstake', 'claim'].includes(action)) {
        return reply.code(400).send({ error: 'Invalid request' });
      }
      if (typeof amount === 'undefined' || isNaN(Number(amount))) {
        return reply.code(400).send({ error: `${action === 'claim' ? 'Claim' : 'Unstake'} amount is invalid.` });
      }
      if (action === 'unstake') {
        // Unstake: Check staking balance
        const [stakeRows] = await fastify.mysql.query(
          `SELECT staked_amount as total FROM stakes WHERE xrpl_address = ?`,
          [userAccount]
        );
        const stakedAmount = stakeRows[0]?.total ? Number(stakeRows[0].total) : 0;
        if (Number(amount) > stakedAmount) {
          return reply.code(400).send({ error: 'Insufficient staking balance.' });
        }
      } else if (action === 'claim') {
        // Claim: Only -1 allowed, pay out all accumulated rewards
        const MIN_FEE = 0.05;
        if (Number(amount) !== -1) {
          return reply.code(400).send({ error: 'Only amount=-1 is allowed for claim.' });
        }
        const accumulatedReward = await getUserAccumulatedReward(fastify, userAccount);
        let claimAmount = accumulatedReward;
        if (claimAmount < MIN_FEE) {
          return reply.code(400).send({ error: `Minimum claim fee (${MIN_FEE} RLUSD) required.` });
        }
        claimAmount = Math.floor((claimAmount - MIN_FEE) * 1000000) / 1000000;
        if (claimAmount <= 0) {
          return reply.code(400).send({ error: 'No claimable amount after fee deduction.' });
        }
        // Replace amount with actual claimAmount to be paid
        amount = claimAmount;
      }
      const nonce = uuidv4();
      const payloadReq = {
        txjson: {
          TransactionType: 'SignIn'
        },
        options: { submit: false, expire: 300 },
        custom_meta: {
          identifier: `g-${action}-${nonce.slice(0, 20)}`,
          blob: {
            action,
            nonce,
            description: `GoldStake ${action}`
          }
        }
      };
      if (userToken) payloadReq.user_token = userToken;
      const res = await fetch('https://xumm.app/api/v1/platform/payload', {
        method: 'POST',
        headers: {
          'X-API-Key': XUMM_API_KEY,
          'X-API-Secret': XUMM_API_SECRET,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payloadReq)
      });
      const payload = await res.json();
      if (!payload || !payload.uuid) {
        console.error('XUMM payload creation failed:', payload);
        return reply.code(500).send({ message: 'Failed to create XUMM payload.', detail: payload });
      }
      // Save uuid, nonce, userAccount, action, amount, created_at, status='pending' to DB
      await fastify.mysql.query(
        `INSERT INTO nonce_requests (xrpl_address, nonce, request_type, amount, status, created_at, uuid) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        [userAccount, nonce, action, amount, Math.floor(Date.now() / 1000), payload.uuid]
      );
      return reply.send({
        uuid: payload.uuid,
        qrUrl: payload.refs.qr_png,
        appUrl: payload.next.always
      });
    } catch (error) {
      console.error('Signature request failed:', error);
      return reply.code(500).send({ message: 'Failed to create signature request.' });
    }
  });

  // 2. Signature verification API
  fastify.post('/verify-signature', async (request, reply) => {
    try {
      const { uuid } = request.body;
      if (!uuid) return reply.code(400).send({ error: 'UUID required' });
      // Query payload result from XUMM REST API
      const res = await fetch(`https://xumm.app/api/v1/platform/payload/${uuid}`, {
        method: 'GET',
        headers: {
          'X-API-Key': XUMM_API_KEY,
          'X-API-Secret': XUMM_API_SECRET
        }
      });
      const payloadResult = await res.json();
      if (payloadResult.meta && payloadResult.meta.signed === true) {
        const signerAccount = payloadResult.response.account;
        // Query request info from DB by uuid
        const [rows] = await fastify.mysql.query(
          `SELECT * FROM nonce_requests WHERE uuid = ? AND status = 'pending' LIMIT 1`,
          [uuid]
        );
        if (rows.length === 0) {
          return reply.code(400).send({ error: 'No pending request found for this uuid' });
        }
        const originalRequest = rows[0];
        if (originalRequest.xrpl_address !== signerAccount) {
          return reply.code(403).send({ message: 'Requester and signer do not match.' });
        }
        const conn = await fastify.mysql.getConnection();
        try {
          await conn.beginTransaction();
          // Update status
          await conn.query(
            `UPDATE nonce_requests SET status = 'verified', verified_at = ? WHERE id = ?`,
            [Math.floor(Date.now() / 1000), originalRequest.id]
          );
          if (originalRequest.request_type === 'unstake') {
            // Register unstake request to queue
            const sendAmount = Math.floor(Number(originalRequest.amount) * 1e6) / 1e6; // Truncate to 6 decimal places
            await conn.query(
              `INSERT INTO unstake_requests (account, send_token, send_amount, created_at, status) VALUES (?, ?, ?, ?, 'pending')`,
              [signerAccount, 'GPC', sendAmount.toString(), Math.floor(Date.now() / 1000)]
            );
            // Deduct staked_amount from stakes table
            await conn.query(
              `UPDATE stakes SET staked_amount = staked_amount - ? WHERE xrpl_address = ?`,
              [sendAmount, signerAccount]
            );
          } else if (originalRequest.request_type === 'claim') {
            // Calculate and verify accumulated reward (within transaction)
            const MIN_FEE = 0.05;
            const accumulatedReward = await getUserAccumulatedReward(fastify, signerAccount);
            if (Number(originalRequest.amount) > accumulatedReward) {
              throw new Error('Insufficient claimable reward.');
            }
            if (accumulatedReward < MIN_FEE) {
              throw new Error(`Minimum claim fee (${MIN_FEE} RLUSD) required.`);
            }
            let claimAmount = Number(originalRequest.amount) - MIN_FEE;
            if (claimAmount <= 0) {
              throw new Error('No claimable amount after fee deduction.');
            }
            claimAmount = Math.floor(claimAmount * 1e6) / 1e6; // Truncate to 6 decimal places
            // Register claim_requests to queue (pay after fee deduction)
            await conn.query(
              `INSERT INTO claim_requests (account, send_token, send_amount, created_at, status) VALUES (?, ?, ?, ?, 'pending')`,
              [signerAccount, 'RLUSD', claimAmount.toString(), Math.floor(Date.now() / 1000)]
            );
            // Reset pocket_reward and update last_claim_at
            await conn.query(
              `UPDATE stakes SET pocket_reward = 0, last_claim_at = ? WHERE xrpl_address = ?`,
              [Math.floor(Date.now() / 1000), signerAccount]
            );
          }
          await conn.commit();
        } catch (txErr) {
          await conn.rollback();
          console.error('Transaction processing failed:', txErr);
          return reply.code(500).send({ message: 'Transaction processing failed.', detail: txErr.message });
        } finally {
          conn.release();
        }
        return reply.send({
          success: true,
          message: originalRequest.request_type === 'unstake'
            ? 'Successfully verified. Unstake request registered to queue and balance deducted.'
            : 'Successfully verified. Claim request registered to queue and reward reset.',
          signer: signerAccount
        });
      } else {
        return reply.code(400).send({ success: false, message: 'Signature not completed or was rejected.' });
      }
    } catch (error) {
      console.error('Signature verification failed:', error);
      return reply.code(500).send({ message: 'Signature verification failed.' });
    }
  });
}
