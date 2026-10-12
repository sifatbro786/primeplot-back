import { env } from '#config/env.js'; // validates env first — exits with a clear message if invalid
import { logger } from '#config/logger.js';
import { connectDB, disconnectDB } from '#config/db.js';
import { createApp } from './src/app.js';
import { startScheduler, stopScheduler } from '#jobs/index.js';
import { closeEmail } from '#integrations/email/index.js';
import { closeSockets, initSockets } from '#sockets/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let server;
let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down…');

  // Hard stop if something hangs (open sockets, stuck query).
  const force = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  try {
    // Socket.IO first: open WebSockets would keep server.close() waiting. io.close() also
    // closes the HTTP server (stop accepting, finish in-flight requests).
    await closeSockets();
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve)); // stop accepting, finish in-flight
    }
    server?.closeIdleConnections?.();
    await stopScheduler(); // finish the in-flight job tick before the DB goes away
    closeEmail();
    await disconnectDB();
    logger.info('Shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    exitCode = 1;
  } finally {
    clearTimeout(force);
    process.exit(exitCode);
  }
}

async function main() {
  await connectDB();

  const app = createApp();
  server = app.listen(env.PORT, () => {
    logger.info(`${env.APP_NAME} API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
  initSockets(server);
  if (env.JOBS_ENABLED) await startScheduler();
  server.on('error', (err) => {
    logger.fatal(
      { err },
      err.code === 'EADDRINUSE' ? `Port ${env.PORT} is already in use` : 'Server error',
    );
    shutdown('server-error', 1);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});

main().catch((err) => {
  logger.fatal({ err: { name: err.name, message: err.message } }, 'Failed to start');
  shutdown('startup-failure', 1);
});
