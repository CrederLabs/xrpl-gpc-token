// src/config/exchangeRate.js

let currentRate = 0;

export const getExchangeRate = () => currentRate;

export const updateExchangeRate = async (fastify) => {
  try {
    const [rows] = await fastify.mysql.query('SELECT rate FROM exchange_rates WHERE swap_type = "GPC_RLUSD" LIMIT 1');
    if (rows && rows.length > 0 && rows[0].rate) {
      currentRate = parseFloat(rows[0].rate);
      // console.log(`[EXCHANGE RATE] GPC_RLUSD rate updated: ${currentRate}`);
    } else {
      console.warn('[EXCHANGE RATE] No rate found in DB, using default');
    }
  } catch (err) {
    console.error('[EXCHANGE RATE] Failed to update rate from DB:', err);
  }
};