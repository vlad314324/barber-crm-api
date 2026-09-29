require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const { startReminderJob } = require('./config/reminderJob');
const { startPlatformRollupJob } = require('./config/platformRollupJob');

const PORT = process.env.PORT || 5000;

async function main() {
  await connectDB();
  if (process.env.DISABLE_REMINDER_JOB === 'true') {
    console.log('Reminder job disabled (DISABLE_REMINDER_JOB=true)');
  } else {
    startReminderJob();
  }
  if (process.env.DISABLE_PLATFORM_ROLLUP_JOB === 'true') {
    console.log('Platform rollup job disabled (DISABLE_PLATFORM_ROLLUP_JOB=true)');
  } else {
    startPlatformRollupJob();
  }
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}

main();
