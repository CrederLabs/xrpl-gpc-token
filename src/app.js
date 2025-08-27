import Fastify from 'fastify';
import autoload from '@fastify/autoload';
import path from 'path';
import { fileURLToPath } from 'url';
import fastifyCron from 'fastify-cron';
import dotenv from 'dotenv';
import db from '@fastify/mysql';
import cors from '@fastify/cors';
import { connectXrpl, startXrplListener, recoverMissedTransactions } from './services/xrplService.js';
import { updateExchangeRate } from './config/exchangeRate.js';
import { startSwapQueueProcessor, startUnstakeQueueProcessor, startClaimQueueProcessor, updateGpcExchangeRate } from './services/cronService.js';
import { Mutex } from 'async-mutex';
import fastifyCaching from '@fastify/caching';
import { sendDiscordAlarm } from './utils/alert.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname'
      }
    }
  }
});

// Create mutex instances for swap, unstake, claim and register to fastify
const swapMutex = new Mutex();
const unstakeMutex = new Mutex();
const claimMutex = new Mutex();
fastify.decorate('swapMutex', swapMutex);
fastify.decorate('unstakeMutex', unstakeMutex);
fastify.decorate('claimMutex', claimMutex);

fastify.register(db, {
  promise: true,
  // Use LOCAL_DB_HOST if LOCAL_MODE is enabled. If DEV_MODE is enabled, only the database name changes to goldstake_dev.
  connectionString: process.env.LOCAL_MODE
    ? `mysql://${process.env.LOCAL_DB_USERNAME}:${process.env.LOCAL_DB_PW}@${process.env.LOCAL_DB_HOST}:${process.env.LOCAL_DB_PORT}/${process.env.LOCAL_DB_NAME}`
    : process.env.DEV_MODE
      ? `mysql://${process.env.DB_USERNAME}:${process.env.DB_PW}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DEV_DB_NAME}`
      : `mysql://${process.env.DB_USERNAME}:${process.env.DB_PW}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`
});

fastify.register(cors, { origin: "*" });

fastify.addHook("onRequest", function (request, reply, next) {
    // /mainnet/ping or /testnet/ping passes without authentication
    if (
        request.raw.url === '/mainnet/ping' ||
        request.raw.url === '/testnet/ping'
    ) {
        return next();
    }

    const expectedOrigin = process.env.FRONTEND_URL;
    const expectedAuthHeader = `Bearer ${process.env.SECRET_KEY}`;

    const requestOrigin = request.headers.origin;
    const authHeader = request.headers.authorization;

    // /admin/reward/rollover API applies a separate IP whitelist (ignored in DEV_MODE)
    const adminRolloverPath = '/admin/reward/rollover';
    const allowedAdminIps = (process.env.ALLOWED_ADMIN_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
    if (request.raw.url && request.raw.url.startsWith(adminRolloverPath)) {
        if (!process.env.DEV_MODE) {
            const remoteIp = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.ip;
            if (!allowedAdminIps.includes(remoteIp)) {
                reply.code(403).send({ error: 'Admin IP Forbidden' });
                return;
            }
        }
    }

    if (process.env.DEV_MODE) {
        console.log('Development mode: Skipping auth checks');
    } else {
        if (!requestOrigin || requestOrigin !== expectedOrigin) {
            reply.code(403).send({ error: 'Forbidden' });
            return;
        }

        if (!authHeader || authHeader !== expectedAuthHeader) {
            reply.code(401).send({ error: 'Unauthorized' });
            return;
        }
    }

    next();
});

// Health check endpoint
fastify.get('/', (request, reply) => {
    return { status: 'ok', service: 'goldstake-api', timestamp: Date.now() };
});

fastify.register(autoload, {
    dir: path.join(__dirname, 'routes'),
    options: {
        prefix: process.env.DEV_MODE ? '/testnet' : '/mainnet'
    }
});

fastify.register(fastifyCaching, {
  expiresIn: 0 // Default: no caching
});

fastify.register(fastifyCron, {
  jobs: [
    {
      cronTime: '*/5 * * * *', // Every 5 minutes
      onTick: async () => {
        await updateGpcExchangeRate(fastify);
        // Internal exchange rate update. No mutex used.
        await updateExchangeRate(fastify);
      }
    },
    {
      cronTime: '* * * * * *', // Every second
      onTick: async () => {
        await fastify.swapMutex.runExclusive(async () => {
          await startSwapQueueProcessor(fastify);
        });
      }
    },
    {
      cronTime: '* * * * * *', // Every second
      onTick: async () => {
        await fastify.unstakeMutex.runExclusive(async () => {
          await startUnstakeQueueProcessor(fastify);
        });
      }
    },
    {
      cronTime: '* * * * * *', // Every second
      onTick: async () => {
        await fastify.claimMutex.runExclusive(async () => {
          await startClaimQueueProcessor(fastify);
        });
      }
    }
  ]
});

const start = async () => {
  try {
    await fastify.ready(); // Wait for all plugins to be registered

    // updateExchangeRate must be started first. The app cannot run without an exchange rate.
    await updateGpcExchangeRate(fastify);
    await updateExchangeRate(fastify);

    // Connect to XRPL client
    await connectXrpl();

    // Recover missed transactions after XRPL server downtime/restart (run once at server boot)
    await recoverMissedTransactions(fastify, { since: 1754554153 });

    // Start XRPL transaction listener
    startXrplListener(fastify);

    fastify.cron.startAllJobs(); // Start all cron jobs

    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    fastify.log.info('Server started');

    sendDiscordAlarm('INFO', 'Server started');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
