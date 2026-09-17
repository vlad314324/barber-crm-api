require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const { startReminderJob } = require('./config/reminderJob');

const PORT = process.env.PORT || 5000;

async function main() {
  await connectDB();
  if (process.env.DISABLE_REMINDER_JOB === 'true') {
    console.log('Reminder job disabled (DISABLE_REMINDER_JOB=true)');
  } else {
    startReminderJob();
  }
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}

main();
