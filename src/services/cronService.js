// startSwapQueueProcessor, startUnstakeQueueProcessor, startClaimQueueProcessor 

// =======================================================
// src/services/cronService.js
// [NEW] Service that periodically processes swap, unstake, and claim queues
// Since these functions are already protected by mutex, there is no need to manage a separate isProcessing flag
// =======================================================
import { sendToken } from './xrplService.js';
import fetch from 'node-fetch';

export const startSwapQueueProcessor = async (fastify) => {
  // let connection;
  // let request;
  try {
    connection = await fastify.mysql.getConnection();
    await connection.beginTransaction();

    // Get the oldest pending request and lock it so other processes cannot access it
    const [rows] = await connection.execute(
      "SELECT * FROM `swap_requests` WHERE `status` = 'pending' ORDER BY `id` ASC LIMIT 1 FOR UPDATE"
    );

    if (rows.length === 0) {
      await connection.commit();
      connection.release();
      //   if (process.env.DEV_MODE) fastify.log.info('No pending swap requests found.');
      return;
    }

    request = rows[0];
    // Change status from pending to processing (within transaction)
    const [updateResult] = await connection.execute(
      "UPDATE `swap_requests` SET `status` = 'processing' WHERE `id` = ? AND `status` = 'pending'",
      [request.id]
    );
    // If another process is already processing, skip
    if (updateResult.affectedRows === 0) {
      await connection.commit();
      connection.release();
      return;
    }
    fastify.log.info(`Processing swap request ID: ${request.id}`);

    // Execute token transfer: already handled by submitAndWait, so no separate transaction handling needed
    const result = await sendToken(
      process.env.GOLDSTAKE_SWAP_POOL_SECRET,
      request.account,
      request.send_token,
      request.send_token === "GPC" ? process.env.GPC_ISSUER_ADDRESS : (process.env.DEV_MODE ? process.env.DEV_RLUSD_ISSUER_ADDRESS : process.env.RLUSD_ISSUER_ADDRESS),
      request.send_amount
    );

    const now = Math.floor(Date.now() / 1000);

    if (result.result.meta.TransactionResult === 'tesSUCCESS') {
      // 1. Update swap_requests table status
      await connection.execute(
        "UPDATE `swap_requests` SET `status` = 'completed' WHERE `id` = ?",
        [request.id]
      );

      // Type is as follows. Backend processes as SWAP_OUT. Frontend displays as desired based on SWAP_OUT and send token.
      // ‘RLUSD sent’ : RLUSD sent from user wallet
      // ‘RLUSD received ’ : RLUSD received to user wallet
      // ‘GPC sent’ : GPC sent from user wallet
      // ‘GPC received ’ : GPC received to user wallet
      
      // 2. Record 'SWAP_OUT' history in transactions table
      await connection.execute(
        "INSERT INTO `transactions` (`xrpl_address`, `tx_type`, `amount`, `symbol`, `tx_hash`, `created_at`) VALUES (?, ?, ?, ?, ?, ?)",
        [request.account, 'SWAP_OUT', request.send_amount, request.send_token, result.result.hash, now]
      );
      fastify.log.info(`Swap request ID: ${request.id} completed successfully.`);
    } else {
        fastify.log.error(`Swap request ID: ${request.id} failed with error: ${result.result.meta.TransactionResult}`);
        // If token transfer fails, update request status to 'failed'
        await connection.execute(
          "UPDATE `swap_requests` SET `status` = 'failed' WHERE `id` = ?",
          [request.id]
        );
        fastify.log.error(`Swap request ID: ${request.id} marked as failed.`);
        // TODO: Send error message to Discord alarm
    }

    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback();
    fastify.log.error('Error processing swap queue:', error);
    // If failed, update request status to 'failed'
    if (connection && typeof request?.id !== 'undefined') {
      try {
        await connection.execute(
          "UPDATE `swap_requests` SET `status` = 'failed', `error_message` = ? WHERE `id` = ?",
          [error.message, request.id]
        );
      } catch (dbError) {
        fastify.log.error(`Failed to update swap request ${request.id} to failed status:`, dbError);
      }
    }
  } finally {
    if (connection) connection.release();
  }
};

export const startUnstakeQueueProcessor = async (fastify) => {
  let connection;
  let request;
  try {
    connection = await fastify.mysql.getConnection();
    await connection.beginTransaction();

    // Get the oldest pending unstake request and lock it
    const [rows] = await connection.execute(
      "SELECT * FROM `unstake_requests` WHERE `status` = 'pending' ORDER BY `id` ASC LIMIT 1 FOR UPDATE"
    );

    if (rows.length === 0) {
      await connection.commit();
      connection.release();
      return;
    }

    request = rows[0];
    // Change status from pending to processing (within transaction)
    const [updateResult] = await connection.execute(
      "UPDATE `unstake_requests` SET `status` = 'processing' WHERE `id` = ? AND `status` = 'pending'",
      [request.id]
    );
    if (updateResult.affectedRows === 0) {
      await connection.commit();
      connection.release();
      return;
    }
    fastify.log.info(`Processing unstake request ID: ${request.id}`);

    // Actual unstake processing: send GPC from STAKE_POOL to user
    const result = await sendToken(
      process.env.GOLDSTAKE_STAKE_POOL_SECRET, // Stake pool secret
      request.account, // User XRPL address
      'GPC',
      process.env.GPC_ISSUER_ADDRESS,
      String(request.send_amount)
    );

    const now = Math.floor(Date.now() / 1000);

    if (result.result && result.result.meta && result.result.meta.TransactionResult === 'tesSUCCESS') {
      // 1. Update unstake request status
      await connection.execute(
        "UPDATE `unstake_requests` SET `status` = 'completed' WHERE `id` = ?",
        [request.id]
      );
      // 2. Record transaction
      await connection.execute(
        "INSERT INTO `transactions` (`xrpl_address`, `tx_type`, `amount`, `symbol`, `tx_hash`, `created_at`) VALUES (?, ?, ?, ?, ?, ?)",
        [request.account, 'UNSTAKE', request.send_amount, 'GPC', result.result.hash, now]
      );
      fastify.log.info(`Unstake request ID: ${request.id} completed successfully.`);
    } else {
      const failReason = result?.result?.meta?.TransactionResult || 'Unknown XRPL error';
      fastify.log.error(`Unstake request ID: ${request.id} failed with error: ${failReason}`);
      await connection.execute(
        "UPDATE `unstake_requests` SET `status` = 'failed', `fail_reason` = ? WHERE `id` = ?",
        [failReason, request.id]
      );
    }

    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback();
    fastify.log.error('Error processing unstake queue:', error);
    // If failed, update request status to 'failed'
    if (connection && typeof request?.id !== 'undefined') {
      try {
        await connection.execute(
          "UPDATE `unstake_requests` SET `status` = 'failed', `fail_reason` = ? WHERE `id` = ?",
          [error.message, request.id]
        );
      } catch (dbError) {
        fastify.log.error(`Failed to update unstake request ${request.id} to failed status:`, dbError);
      }
    }
  } finally {
    if (connection) connection.release();
  }
};

export const startClaimQueueProcessor = async (fastify) => {
    let connection;
    let request;
    try {
        connection = await fastify.mysql.getConnection();
        await connection.beginTransaction();

        // Get the oldest pending claim request and lock it
        const [rows] = await connection.execute(
            "SELECT * FROM `claim_requests` WHERE `status` = 'pending' ORDER BY `id` ASC LIMIT 1 FOR UPDATE"
        );

        if (rows.length === 0) {
            await connection.commit();
            connection.release();
            return;
        }

        request = rows[0];
        // Change status from pending to processing (within transaction)
        const [updateResult] = await connection.execute(
            "UPDATE `claim_requests` SET `status` = 'processing' WHERE `id` = ? AND `status` = 'pending'",
            [request.id]
        );
        if (updateResult.affectedRows === 0) {
            await connection.commit();
            connection.release();
            return;
        }
        fastify.log.info(`Processing claim request ID: ${request.id}`);

        // Actual RLUSD transfer: send RLUSD from CLAIM_POOL to user
        // Truncate to 6 decimal places
        const sendAmount =
            Math.floor(Number(request.send_amount) * 1e6) / 1e6 + '';

        const result = await sendToken(
            process.env.GOLDSTAKE_STAKE_POOL_SECRET, // Pool secret
            request.account, // User XRPL address
            process.env.DEV_MODE ? 'RLD' : 'RLUSD',
            process.env.DEV_MODE ? process.env.DEV_RLUSD_ISSUER_ADDRESS : process.env.RLUSD_ISSUER_ADDRESS,
            sendAmount
        );

        const now = Math.floor(Date.now() / 1000);

        if (result.result && result.result.meta && result.result.meta.TransactionResult === 'tesSUCCESS') {
            // 1. Update claim request status
            await connection.execute(
                "UPDATE `claim_requests` SET `status` = 'completed' WHERE `id` = ?",
                [request.id]
            );
            // 2. Record transaction
            await connection.execute(
                "INSERT INTO `transactions` (`xrpl_address`, `tx_type`, `amount`, `symbol`, `tx_hash`, `created_at`) VALUES (?, ?, ?, ?, ?, ?)",
                [request.account, 'CLAIM', sendAmount, process.env.DEV_MODE ? 'RLD' : 'RLUSD', result.result.hash, now]
            );
            fastify.log.info(`Claim request ID: ${request.id} completed successfully.`);
        } else {
            const failReason = result?.result?.meta?.TransactionResult || 'Unknown XRPL error';
            fastify.log.error(`Claim request ID: ${request.id} failed with error: ${failReason}`);
            await connection.execute(
                "UPDATE `claim_requests` SET `status` = 'failed', `fail_reason` = ? WHERE `id` = ?",
                [failReason, request.id]
            );
        }

        await connection.commit();
    } catch (error) {
        if (connection) await connection.rollback();
        fastify.log.error('Error processing claim queue:', error);
        // If failed, update request status to 'failed'
        if (connection && typeof request?.id !== 'undefined') {
            try {
                await connection.execute(
                    "UPDATE `claim_requests` SET `status` = 'failed', `fail_reason` = ? WHERE `id` = ?",
                    [error.message, request.id]
                );
            } catch (dbError) {
                fastify.log.error(`Failed to update claim request ${request.id} to failed status:`, dbError);
            }
        }
    } finally {
        if (connection) connection.release();
    }
};

/**
 * Cron function to fetch GPC price from external API and update exchange_rates table
 */
export const updateGpcExchangeRate = async (fastify) => {
  try {
    const apiUrl = 'https://api.goldstation.io/v2/dex/token/price?tokenAddress=0x1b27D7A06DeEa4d5CB4fd60c164153C90f64281D'; // Avalanche GPC token address
    const apiKey = 'Bearer ' + process.env.API_BEARER_KEY;

    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) {
      fastify.log.error(`Failed to fetch GPC price: ${res.status} ${res.statusText}`);
      return;
    }
    const data = await res.json();
    // Example: { "price": 1.2345 }
    const price = Number(data.price);
    if (!price || isNaN(price)) {
      fastify.log.error('Failed to parse GPC price data:', data);
      return;
    }
    // Update DB (swap_type: 'RLUSD_GPC', change swap_type if needed)
    await fastify.mysql.query(
      'UPDATE exchange_rates SET rate = ? WHERE swap_type = ?',
      [Math.floor(price * 10000) / 10000, 'RLUSD_GPC'] // Truncate to 4 decimal places
    );
    fastify.log.info(`GPC price updated: ${price}`);
  } catch (error) {
    fastify.log.error('GPC price cron error:', error);
  }
};