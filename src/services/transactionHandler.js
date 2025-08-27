// =======================================================
// src/services/transactionHandlers.js
// [Updated] Use tx.meta.delivered_amount and changed sendToken call method
// =======================================================
import { checkTrustLine, sendToken } from './xrplService.js';
import { getExchangeRate } from '../config/exchangeRate.js';
import { sendDiscordAlarm } from '../utils/alert.js';

// GPC -> RLUSD 스왑할 때 RLUSD 차감되는 수량: 수수료
const SWAP_FEE_GPC = 0.05;

export const handleSwapPayment = async (fastify, tx, receivedToken) => {
    const userAccount = tx.tx_json.Account;
    // Truncate to 6 decimal places
    const receivedAmount = Math.floor(parseFloat(tx.meta.delivered_amount.value) * 1e6) / 1e6;

    console.log(`Handling SWAP: ${userAccount} sent ${receivedAmount} ${receivedToken}.`);

    // User tries to swap RLUSD -> GPC
    if (receivedToken === "RLD" || receivedToken === "RLUSD") {
        // Check if user has GPC trust line
        let hasTrustLine = await checkTrustLine(userAccount, "GPC", process.env.GPC_ISSUER_ADDRESS);
        let failReason = null;
        if (!hasTrustLine) {
            failReason = `no_gpc_trustline`;
        } else if (receivedAmount < 0.1) {
            failReason = `amount_too_small`;
        } else {
            const exchangeRate = getExchangeRate();
            if (exchangeRate <= 0) {
                failReason = `invalid_exchange_rate`;
            } else {
                let gpcToSend = (receivedAmount / exchangeRate);
                gpcToSend = Math.floor(gpcToSend * 1e6) / 1e6; // Truncate to 6 decimal places
                if (gpcToSend <= 0) {
                    failReason = `amount_too_small`;
                } else {
                    // Success
                    try {
                        console.log(`Swap in success: Received ${receivedAmount} ${receivedToken} and will send ${gpcToSend} GPC to ${userAccount}.`);
                        const connection = await fastify.mysql.getConnection();
                        try {
                            await connection.beginTransaction();
                            await connection.execute(
                                `INSERT INTO swap_requests (account, receive_token, receive_amount, send_token, send_amount, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                                [
                                    userAccount,
                                    receivedToken,
                                    receivedAmount,
                                    'GPC',
                                    gpcToSend,
                                    Math.floor(Date.now() / 1000)
                                ]
                            );
                            await connection.execute(
                                `INSERT INTO transactions (xrpl_address, tx_type, amount, symbol, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                                [
                                    userAccount,
                                    'SWAP_IN',
                                    receivedAmount,
                                    receivedToken,
                                    tx.hash,
                                    Math.floor(Date.now() / 1000)
                                ]
                            );
                            await connection.commit();
                        } catch (err) {
                            await connection.rollback();
                            throw err;
                        } finally {
                            connection.release();
                        }
                        return;
                    } catch (error) {
                        const msg = `Swap failed for ${userAccount}: ${error}`;
                        console.error(msg);
                        sendDiscordAlarm('ERROR', msg);
                        return;
                    }
                }
            }
        }
        // If swap is not possible: record in swap_requests with status='failed'
        if (failReason) {
            const msg = `Swap failed: ${failReason} (${userAccount}, ${receivedAmount} ${receivedToken})`;
            console.error(msg);
            sendDiscordAlarm('WARN', msg);
            const connection = await fastify.mysql.getConnection();
            try {
                await connection.execute(
                    `INSERT INTO swap_requests (account, receive_token, receive_amount, send_token, send_amount, created_at, status, fail_reason) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)`,
                    [
                        userAccount,
                        receivedToken,
                        receivedAmount,
                        'GPC',
                        0,
                        Math.floor(Date.now() / 1000),
                        failReason
                    ]
                );
            } finally {
                connection.release();
            }
            return;
        }

    } else if (receivedToken === "GPC") {
        // User tries to swap GPC -> RLUSD
        let hasTrustLine;
        let failReason = null;
        if (process.env.DEV_MODE) {
            hasTrustLine = await checkTrustLine(userAccount, "RLD", process.env.DEV_RLUSD_ISSUER_ADDRESS);
        } else {
            hasTrustLine = await checkTrustLine(userAccount, "RLUSD", process.env.RLUSD_ISSUER_ADDRESS);
        }
        if (!hasTrustLine) {
            failReason = `no_rlusd_trustline`;
        } else if (receivedAmount < 0.1 || receivedAmount > 1000) {
            // Only allow 0.1 GPC or more, up to 1000 GPC
            failReason = `out_of_range_amount`;
        } else {
            const exchangeRate = getExchangeRate();
            if (exchangeRate <= 0) {
                failReason = `invalid_exchange_rate`;
            } else {
                let rlusdToSend = (receivedAmount * exchangeRate) - SWAP_FEE_GPC;   // GPC → RLD: 교환비 적용 후 0.05 RLD 수수료 차감
                rlusdToSend = Math.floor(rlusdToSend * 1e6) / 1e6; // Truncate to 6 decimal places
                if (rlusdToSend <= 0) {
                    failReason = `amount_too_small`;
                } else {
                    // Success
                    try {
                        console.log(`Swap success: Sent ${rlusdToSend} ${process.env.DEV_MODE ? "RLD" : "RLUSD"} to ${userAccount}.`);
                        const connection = await fastify.mysql.getConnection();
                        try {
                            await connection.beginTransaction();
                            await connection.execute(
                                `INSERT INTO swap_requests (account, receive_token, receive_amount, send_token, send_amount, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                                [
                                    userAccount,
                                    'GPC',
                                    receivedAmount,
                                    process.env.DEV_MODE ? "RLD" : "RLUSD",
                                    rlusdToSend,
                                    Math.floor(Date.now() / 1000)
                                ]
                            );
                            await connection.execute(
                                `INSERT INTO transactions (xrpl_address, tx_type, amount, symbol, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                                [
                                    userAccount,
                                    'SWAP_IN',
                                    receivedAmount,
                                    'GPC',
                                    tx.hash,
                                    Math.floor(Date.now() / 1000)
                                ]
                            );
                            await connection.commit();
                        } catch (err) {
                            await connection.rollback();
                            throw err;
                        } finally {
                            connection.release();
                        }
                        return;
                    } catch (error) {
                        const msg = `Swap failed for ${userAccount}: ${error}`;
                        console.error(msg);
                        sendDiscordAlarm('ERROR', msg);
                        // TODO: Record failure in DB
                        return;
                    }
                }
            }
        }
        // If swap is not possible: record in swap_requests with status='failed'
        if (failReason) {
            const msg = `Swap failed: ${failReason} (${userAccount}, ${receivedAmount} GPC)`;
            console.error(msg);
            sendDiscordAlarm('WARN', msg);
            const connection = await fastify.mysql.getConnection();
            try {
                await connection.execute(
                    `INSERT INTO swap_requests (account, receive_token, receive_amount, send_token, send_amount, created_at, status, fail_reason) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)`,
                    [
                        userAccount,
                        'GPC',
                        receivedAmount,
                        process.env.DEV_MODE ? "RLD" : "RLUSD",
                        0,
                        Math.floor(Date.now() / 1000),
                        failReason
                    ]
                );
            } finally {
                connection.release();
            }
            return;
        }
    }
};

export const handleStakePayment = async (fastify, tx, receivedToken) => {
    const userAccount = tx.tx_json.Account;
    // Truncate to 6 decimal places
    const stakedAmount = Math.floor(parseFloat(tx.meta.delivered_amount.value) * 1e6) / 1e6;

    console.log(`Handling STAKE: ${userAccount} staked ${stakedAmount} GPC.`);

    // Must stake at least 1 GPC
    if (stakedAmount < 1) {
        const msg = `Stake failed: Amount must be at least 1 GPC.`;
        console.error(msg);
        sendDiscordAlarm('WARN', msg);
        return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Record staking info in DB (stakes table)
    // stakes: id, user_account, amount, staked_at, status
    try {
        const connection = await fastify.mysql.getConnection();
        try {
            await connection.beginTransaction();
            // If exists, update; if not, insert
            await connection.execute(
                `INSERT INTO stakes (xrpl_address, staked_amount, last_claim_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   staked_amount = staked_amount + VALUES(staked_amount),
                   updated_at = VALUES(updated_at)`,
                [userAccount, stakedAmount, now, now, now]
            );
            // Add record to transactions table (tx_type: 'STAKE')
            await connection.execute(
                `INSERT INTO transactions (xrpl_address, tx_type, amount, symbol, tx_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    userAccount,
                    'STAKE',
                    stakedAmount,
                    receivedToken,
                    tx.hash,
                    now
                ]
            );
            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
        console.log(`Stake recorded: ${userAccount} staked ${stakedAmount} GPC.`);
    } catch (error) {
        const msg = `Failed to record stake: ${error}`;
        console.error(msg);
        sendDiscordAlarm('ERROR', msg);
    }
}

// Calculate accumulated reward for each user
// reward_info: duration(30), total_reward(100), status='active' reward pool
// Calculate accumulated reward based on total staked GPC and user's staking ratio
export const getUserAccumulatedReward = async (fastify, userAccount) => {
    // 1. Get active reward pool info (add stake_token, reward_token conditions)
    const stakeToken = 'GPC';
    const rewardToken = 'RLUSD';
    const FIXED_APR = 0.72; // 72% fixed annual interest rate

    const [rewardRows] = await fastify.mysql.query(
        `SELECT * FROM reward_info WHERE status = 'active' AND stake_token = ? AND reward_token = ? ORDER BY period_start DESC LIMIT 1`,
        [stakeToken, rewardToken]
    );
    if (rewardRows.length === 0) {
      // If no reward pool, return only pocket_reward
      const [stakeRows] = await fastify.mysql.query(
        `SELECT pocket_reward FROM stakes WHERE xrpl_address = ?`,
        [userAccount]
      );
      return stakeRows.length > 0 ? Number(stakeRows[0].pocket_reward || 0) : 0;
    }
    const reward = rewardRows[0];
    const now = Math.floor(Date.now() / 1000);
    const periodStart = Number(reward.period_start);
    const periodEnd = periodStart + (Number(reward.duration) * 86400);

    // 2. Get user's staking info
    const [stakeRows] = await fastify.mysql.query(
        `SELECT staked_amount, created_at, updated_at, last_claim_at, pocket_reward FROM stakes WHERE xrpl_address = ?`,
        [userAccount]
    );
    if (!stakeRows || stakeRows.length === 0) {
      return 0;
    }
    const userRow = stakeRows[0];

    // Calculate staking period (seconds)
    const updatedAt = Number(userRow.updated_at) || 0;
    const lastClaimAt = Number(userRow.last_claim_at) || 0;
    const rewardStart = Math.max(updatedAt, lastClaimAt, periodStart);
    const rewardEndForUser = Math.min(now, periodEnd);
    const rewardDuration = Math.max(0, rewardEndForUser - rewardStart);

    // Calculate reward: staked_amount * (APR / 365 / 86400) * rewardDuration
    // APR is annual, so daily rate = APR / 365, per second = APR / 365 / 86400
    const stakedAmount = Number(userRow.staked_amount) || 0;
    const pocketReward = Number(userRow.pocket_reward || 0);

    if (rewardDuration === 0 || stakedAmount === 0) {
      return pocketReward;
    }

    const perSecondRate = FIXED_APR / 365 / 86400;
    const rewardAccrued = stakedAmount * perSecondRate * rewardDuration;

    // Truncate to 6 decimal places before returning
    return Math.floor((pocketReward + rewardAccrued) * 1e6) / 1e6;
};

// Reward pool rollover(settlement) function: accumulate unsettled rewards for all users in pocket_reward, change status of existing reward_info to ended
// type: 'end' | 'snapshot'
export const rolloverRewardPool = async (fastify, { type = 'end' } = {}) => {
    // 1. Get current active reward_info
    const stakeToken = 'GPC';
    const rewardToken = 'RLUSD'; // Use env variable if needed
    const [rewardRows] = await fastify.mysql.query(
        `SELECT * FROM reward_info WHERE status = 'active' AND stake_token = ? AND reward_token = ? ORDER BY period_start DESC LIMIT 1`,
        [stakeToken, rewardToken]
    );
    if (rewardRows.length === 0) {
        sendDiscordAlarm('ERROR', 'No active reward pool');
        throw new Error('No active reward pool');
    }
    const reward = rewardRows[0];
    const now = Math.floor(Date.now() / 1000);

    // 2. Get all stakes
    const [stakeRows] = await fastify.mysql.query(
        `SELECT xrpl_address FROM stakes`
    );
    let updatedCount = 0;
    for (const row of stakeRows) {
        const userAccount = row.xrpl_address;
        // Calculate accumulated reward for each user
        const rewardAmount = await getUserAccumulatedReward(fastify, userAccount);
        // Accumulate in pocket_reward, update updated_at
        await fastify.mysql.query(
            `UPDATE stakes SET pocket_reward = ?, updated_at = ? WHERE xrpl_address = ?`,
            [rewardAmount, now, userAccount]
        );
        updatedCount++;
    }
    // For snapshot, reward_info is left as is, only user's updated_at is updated to now
    if (type === 'end') {
        // Change status of existing reward_info to ended
        await fastify.mysql.query(
            `UPDATE reward_info SET status = 'ended' WHERE id = ?`,
            [reward.id]
        );
    }

    return { updatedCount, type };
};
