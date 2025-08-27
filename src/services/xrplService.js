// =======================================================
// src/services/xrplService.js
// Core file for all logic interacting with XRPL.
// =======================================================
// There are two wallet addresses:
// GOLDSTAKE_SWAP_POOL_ADDRESS (RLUSD <-> GPC): rQU2LkjttEmWyY56jgmGXZND5yriWihZMW
// GOLDSTAKE_STAKE_POOL_ADDRESS: r9H4gzDaxtsB41iMYbUDNtLHjCeBZH88kb
// When staking GPC, RLUSD is paid as a reward. When a user requests unstake, GPC must be returned.
// GOLDSTAKE_SWAP_POOL_SECRET
// GOLDSTAKE_STAKE_POOL_SECRET

import { Client, Wallet, xrpToDrops, dropsToXrp, isValidAddress } from 'xrpl';
import { handleSwapPayment, handleStakePayment } from './transactionHandler.js';
import { sendDiscordAlarm } from '../utils/alert.js';

const DEV_RLD_ISSUER = "rs1BTRfAwp4KpBaPuND8WoESDT3JzQoxUq"; // RLD issuer address for development
const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"; // RLUSD issuer address
const GPC_ISSUER = "r4WfXjE9qGrPvRgTWBbp8CT7cb5Ur7iX6Q"; // GPC issuer address

let client;

export const connectXrpl = async () => {
  // XRPL_SERVER
  // DEV_XRPL_SERVER

  // client = new Client(process.env.XRPL_SERVER);
  if (process.env.DEV_MODE) {
    console.log('Development mode: Using DEV_XRPL_SERVER');
    client = new Client(process.env.DEV_XRPL_SERVER);
  } else {
    console.log('Production mode: Using XRPL_SERVER');
    client = new Client(process.env.XRPL_SERVER);
  }
  
  client.on('error', (errorCode, errorMessage) => {
    console.error(`XRPL client error: ${errorCode} - ${errorMessage}`);
    sendDiscordAlarm('ERROR', `XRPL client error: ${errorCode} - ${errorMessage}`);
  });
  console.log('Connecting to XRPL...');
  try {
    await client.connect();
    console.log('XRPL connected.');
  } catch (err) {
    console.error('Failed to connect to XRPL:', err);
    sendDiscordAlarm('ERROR', `Failed to connect to XRPL: ${err.message}`);
    throw err;
  }
};

export const getXrplClient = () => {
  if (!client || !client.isConnected()) {
    sendDiscordAlarm('ERROR', 'XRPL client is not connected.');
    throw new Error('XRPL client is not connected.');
  }
  return client;
};

/**
 * Start XRPL transaction listener: Swap Pool, Stake Pool
 * Detects all transactions incoming to service wallet addresses.
 */
export const startXrplListener = async (fastify) => {
  if (!client.isConnected()) await connectXrpl();

  const accountsToSubscribe = [
    process.env.GOLDSTAKE_SWAP_POOL_ADDRESS,
    process.env.GOLDSTAKE_STAKE_POOL_ADDRESS
  ];

  console.log(`Subscribing to transactions for accounts: ${accountsToSubscribe.join(', ')}`);

  try {
    const response = await client.request({
      command: 'subscribe',
      accounts: accountsToSubscribe,
    });
    console.log('Successfully subscribed to accounts:', response);
  } catch(error) {
    console.error('Failed to subscribe:', error);
    sendDiscordAlarm('ERROR', `Failed to subscribe to XRPL accounts: ${error.message}`);
    return;
  }
  
  client.on('transaction', async (tx) => {
    // [Debug] Log all events without filtering.
    // console.log('[RAW EVENT] Received an event from XRPL:', JSON.stringify(tx, null, 2));

    // Only process when transaction is validated and type is Payment
    if (!tx.validated || tx.tx_json?.TransactionType !== 'Payment') {
      return;
    }

    const destination = tx.tx_json.Destination;

    // -------------------------------------- Incoming to Swap address START --------------------------------------
    // Incoming to Swap address: two cases
    // 1. RLUSD -> GPC swap
    // 2. GPC -> RLUSD swap
    if (destination === process.env.GOLDSTAKE_SWAP_POOL_ADDRESS) {
      console.log('[SWAP] Received a validated payment.');
      const deliverMax = tx.tx_json.DeliverMax;
      // Use "RLD" for dev, "RLUSD" for mainnet

      // 1. RLUSD -> GPC swap
      if (process.env.DEV_MODE) {
        if (typeof deliverMax === 'object' && deliverMax.currency === "RLD" && deliverMax.issuer === DEV_RLD_ISSUER) {
          handleSwapPayment(fastify, tx, "RLD");
        }
      } else {
        if (typeof deliverMax === 'object' && deliverMax.currency === "RLUSD" && deliverMax.issuer === RLUSD_ISSUER) {
          handleSwapPayment(fastify, tx, "RLUSD");
        }
      }

      // 2. GPC -> RLUSD swap
      if (typeof deliverMax === 'object' && deliverMax.currency === "GPC" && deliverMax.issuer === GPC_ISSUER) {
        handleSwapPayment(fastify, tx, "GPC");
      }
    }
    // -------------------------------------- Incoming to Swap address END --------------------------------------

    // -------------------------------------- Incoming to Stake address START --------------------------------------
    if (destination === process.env.GOLDSTAKE_STAKE_POOL_ADDRESS) {
      console.log('[STAKE] Received a validated payment.');
       const deliverMax = tx.tx_json.DeliverMax;
       // Both dev and mainnet use GPC, issuer is the same
       if (typeof deliverMax === 'object' && deliverMax.currency === "GPC" && deliverMax.issuer === GPC_ISSUER) {
        handleStakePayment(fastify, tx, "GPC");
      }
    }
    // -------------------------------------- Incoming to Stake address END --------------------------------------
  });
};

/**
 * Checks if the user has set a trust line for a specific token.
 * @param {string} account - User account address to check
 * @param {string} currencyCode - Token code (e.g., 'GPC')
 * @param {string} issuerAddress - Token issuer address
 * @returns {Promise<boolean>}
 */
export const checkTrustLine = async (account, currencyCode, issuerAddress) => {
  try {
    const response = await client.request({
      command: 'account_lines',
      account: account,
      ledger_index: 'validated',
    });

    return response.result.lines.some(
      line => line.currency === currencyCode && line.account === issuerAddress
    );
  } catch (error) {
    console.error(`Error checking trust line for ${account}:`, error);
    sendDiscordAlarm('ERROR', `Error checking trust line for ${account}: ${error.message}`);
    return false;
  }
};

/**
 * Sends GPC or RLUSD token to a user.
 * @param {string} secret - Service wallet secret
 * @param {string} destination - User account address to receive
 * @param {string} currencyCode - Token code to send
 * @param {string} issuerAddress - Token issuer address to send
 * @param {string} value - Amount to send (string)
 * @returns {Promise<object>} - Transaction result
 */
export const sendToken = async (secret, destination, currencyCode, issuerAddress, value) => {
  if (!client || !client.isConnected()) {
    sendDiscordAlarm('ERROR', 'XRPL client is not connected. Trying to reconnect...');
    await connectXrpl();
  }
  const wallet = Wallet.fromSeed(secret);

  const paymentTx = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: destination,
    Amount: {
      currency: currencyCode,
      value: value,
      issuer: issuerAddress,
    },
  };

  try {
    const prepared = await client.autofill(paymentTx);
    const signed = wallet.sign(prepared);
    console.log(`Sending ${value} ${currencyCode} to ${destination}...`);
    const result = await client.submitAndWait(signed.tx_blob);
    // Only print essential info from result as it can be too long.
    // destination account, symbol, amount, transaction hash
    console.log(`Transaction result: Sent ${value} ${currencyCode} to ${destination}. Transaction hash: ${result.result.hash}`);
    return result;
  } catch (err) {
    console.error(`Failed to send token: ${err}`);
    sendDiscordAlarm('ERROR', `Failed to send token: ${err.message}`);
    throw err;
  }
};

/**
 * Recovery function for missed swap/stake transactions when XRPL server is down/restarted.
 * - Uses account_tx to fetch recent transactions and reprocess only those not in DB (or not processed).
 * - Must be run once at server boot or periodically.
 */
export const recoverMissedTransactions = async (fastify, options = {}) => {
  if (!client || !client.isConnected()) await connectXrpl();

  const swapAddress = process.env.GOLDSTAKE_SWAP_POOL_ADDRESS;
  const stakeAddress = process.env.GOLDSTAKE_STAKE_POOL_ADDRESS;
  const addresses = [swapAddress, stakeAddress];
  const limit = options.limit || 5; // Recover only the latest 5 (adjust as needed)
  const since = options.since || 0; // unix timestamp (seconds)

  let totalProcessed = 0;
  for (const address of addresses) {
    let marker = undefined;
    let fetched = 0;
    while (fetched < limit) {
      const req = {
        command: 'account_tx',
        account: address,
        ledger_index_min: -1,
        ledger_index_max: -1,
        binary: false,
        limit: Math.min(20, limit - fetched),
      };
      if (marker) req.marker = marker;
      let resp;
      try {
        resp = await client.request(req);
      } catch (err) {
        console.error(`[recover] Failed to fetch account_tx for ${address}:`, err);
        sendDiscordAlarm('ERROR', `[recover] Failed to fetch account_tx for ${address}: ${err.message}`);
        break;
      }
      const txs = resp.result.transactions;
      if (!txs || txs.length === 0) break;
      for (const txObj of txs) {
        // If txObj.tx is missing, use txObj.tx_json (account_tx response format compatibility)
        const tx = txObj.tx || txObj.tx_json;
        const meta = txObj.meta;
        const hash = txObj.hash;
        const deliveredAmount = meta?.delivered_amount?.value;
        // Only validated and Payment type
        if (!txObj.validated || !tx || tx.TransactionType !== 'Payment') continue;
        // Filter by unix timestamp
        const txDate = tx.date || txObj.tx_json?.date;
        if (since && txDate && txDate < since) continue;
        // Skip already processed transactions (e.g., check if tx.hash exists in DB)
        let rows;
        try {
          [rows] = await fastify.mysql.query(
            'SELECT COUNT(*) AS cnt FROM transactions WHERE tx_hash = ?',
            [hash]
          );
        } catch (err) {
          console.error(`[recover] DB error while checking tx_hash: ${hash}`, err);
          sendDiscordAlarm('ERROR', `[recover] DB error while checking tx_hash: ${hash}, ${err.message}`);
          continue;
        }
        if (rows[0].cnt > 0) continue;

        // Print summary log
        console.log(`[recover] ${address === swapAddress ? 'SWAP' : 'STAKE'} tx: hash=${hash}, account=${tx.Account || tx.Destination}, amount=${tx.Amount?.value || deliveredAmount}`);

        // Distinguish and process swap/stake
        if (address === swapAddress) {
          // Transaction deposited to swap pool
          const deliverMax = tx.DeliverMax;
          if (process.env.DEV_MODE) {
            if (typeof deliverMax === 'object' && deliverMax.currency === 'RLD' && deliverMax.issuer === DEV_RLD_ISSUER) {
              try {
                await handleSwapPayment(fastify, { tx_json: tx, meta, hash }, 'RLD');
                totalProcessed++;
                console.log(`[recover] SWAP processed successfully: hash=${hash}`);
              } catch (err) {
                console.error(`[recover] SWAP processing failed: hash=${hash}, error=${err}`);
                sendDiscordAlarm('ERROR', `[recover] SWAP processing failed: hash=${hash}, error=${err.message}`);
              }
            }
          } else {
            if (typeof deliverMax === 'object' && deliverMax.currency === 'RLUSD' && deliverMax.issuer === RLUSD_ISSUER) {
              try {
                await handleSwapPayment(fastify, { tx_json: tx, meta, hash }, 'RLUSD');
                totalProcessed++;
                console.log(`[recover] SWAP processed successfully: hash=${hash}`);
              } catch (err) {
                console.error(`[recover] SWAP processing failed: hash=${hash}, error=${err}`);
                sendDiscordAlarm('ERROR', `[recover] SWAP processing failed: hash=${hash}, error=${err.message}`);
              }
            }
          }
          if (typeof deliverMax === 'object' && deliverMax.currency === 'GPC' && deliverMax.issuer === GPC_ISSUER) {
            try {
              await handleSwapPayment(fastify, { tx_json: tx, meta, hash }, 'GPC');
              totalProcessed++;
              console.log(`[recover] SWAP processed successfully: hash=${hash}`);
            } catch (err) {
              console.error(`[recover] SWAP processing failed: hash=${hash}, error=${err}`);
              sendDiscordAlarm('ERROR', `[recover] SWAP processing failed: hash=${hash}, error=${err.message}`);
            }
          }
        } else if (address === stakeAddress) {
          // Transaction deposited to stake pool
          const deliverMax = tx.DeliverMax;
          if (typeof deliverMax === 'object' && deliverMax.currency === 'GPC' && deliverMax.issuer === GPC_ISSUER) {
            try {
              await handleStakePayment(fastify, { tx_json: tx, meta, hash }, 'GPC');
              totalProcessed++;
              console.log(`[recover] STAKE processed successfully: hash=${hash}`);
            } catch (err) {
              console.error(`[recover] STAKE processing failed: hash=${hash}, error=${err}`);
              sendDiscordAlarm('ERROR', `[recover] STAKE processing failed: hash=${hash}, error=${err.message}`);
            }
          }
        }
      }
      fetched += txs.length;
      marker = resp.result.marker;
      if (!marker) break;
    }
  }
  console.log(`[XRPL] Recovery complete: ${totalProcessed} missed swap/stake pool transactions processed.`);
};

/**
 * Function to check if an XRPL address is valid
 * @param {string} address - XRPL address to check
 * @returns {boolean} - true if valid, false otherwise
 */
export const isValidXrplAddress = (address) => {
  return isValidAddress(address);
};