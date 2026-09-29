require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const { startReminderJob } = require('./config/reminderJob');
const { startPlatformRollupJob } = require('./config/platformRollupJob');
const { closeAllTenantConnections } = require('./config/tenantDb');

const PORT = process.env.PORT || 5000;

// Без цих змінних додаток або взагалі не підключиться (MONGO_URI), або
// підніметься й виглядатиме робочим, а тихо ламатиметься на першому ж
// реальному запиті (JWT_SECRET/PLATFORM_JWT_SECRET — усі токени невалідні;
// EMAIL_USER/BREVO_API_KEY — усі листи мовчки провалюються). Явна перевірка
// на старті замість розмитого краху десь усередині запиту.
const REQUIRED_ENV_VARS = ['MONGO_URI', 'JWT_SECRET', 'PLATFORM_JWT_SECRET', 'EMAIL_USER', 'BREVO_API_KEY'];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // Лише ІМЕНА змінних у повідомленні — жодних значень, навіть у разі помилки.
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

const SHUTDOWN_TIMEOUT_MS = 15000;

async function main() {
  validateEnv();
  await connectDB();

  let reminderTask = null;
  if (process.env.DISABLE_REMINDER_JOB === 'true') {
    console.log('Reminder job disabled (DISABLE_REMINDER_JOB=true)');
  } else {
    reminderTask = startReminderJob();
  }

  let rollupTask = null;
  if (process.env.DISABLE_PLATFORM_ROLLUP_JOB === 'true') {
    console.log('Platform rollup job disabled (DISABLE_PLATFORM_ROLLUP_JOB=true)');
  } else {
    rollupTask = startPlatformRollupJob();
  }

  const server = app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down gracefully...`);

    reminderTask?.stop();
    rollupTask?.stop();

    // Безпечна сітка: якщо активні запити/з'єднання ніколи не спорожніють
    // (наприклад, зависле з'єднання клієнта), не висіти вічно — примусово
    // завершити процес через SHUTDOWN_TIMEOUT_MS.
    const forceExitTimer = setTimeout(() => {
      console.error(`Forced shutdown after ${SHUTDOWN_TIMEOUT_MS}ms — some connections did not drain`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    server.close(async (err) => {
      if (err) console.error('Error while closing HTTP server:', err.message);
      try {
        await closeAllTenantConnections();
        await connectDB.close();
      } catch (closeErr) {
        console.error('Error while closing database connections:', closeErr.message);
      }
      clearTimeout(forceExitTimer);
      console.log('Shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
