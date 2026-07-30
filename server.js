require('dotenv').config();
const express = require('express');
const connectDB = require('./config/db');
const cors = require('cors');
const { startReminderJob } = require('./config/reminderJob');
const tenantResolver = require('./middleware/tenantResolver');
const verifyToken = require('./middleware/verifyToken');

const app = express();

app.use(cors());
app.use(express.json());

const tenantRouter = express.Router({ mergeParams: true });
tenantRouter.use(tenantResolver);
tenantRouter.use('/auth', require('./routes/authRoutes'));
tenantRouter.use('/clients', verifyToken, require('./routes/clientRoutes'));
tenantRouter.use('/employees', verifyToken, require('./routes/employeeRoutes'));
tenantRouter.use('/appointments', verifyToken, require('./routes/appointmentRoutes'));
tenantRouter.use('/services', verifyToken, require('./routes/serviceRoutes'));
tenantRouter.use('/reviews', verifyToken, require('./routes/reviewRoutes'));
tenantRouter.use('/booking', require('./routes/bookingRoutes'));
tenantRouter.use('/settings', verifyToken, require('./routes/settingsRoutes'));
tenantRouter.use('/analytics', verifyToken, require('./routes/analyticsRoutes'));

app.use('/api/salons', require('./routes/salonRoutes'));
app.use('/api/:salonSlug', tenantRouter);

app.get('/', (req, res) => res.send('BarberCRM API is running'));

const PORT = process.env.PORT || 5000;

async function main() {
  await connectDB();
  startReminderJob();
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}

main();
