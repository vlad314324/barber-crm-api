const mongoose = require('mongoose');
const { buildMongoUri } = require('./mongoUri');

const connectDB = async () => {
  try {
    await mongoose.connect(buildMongoUri(process.env.MONGO_URI, 'platform'));
    console.log('MongoDB connected');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
};

// Для graceful shutdown (server.js) — закриває платформне з'єднання, яке
// відкрив connectDB() вище. Властивість на самій функції, а не окремий
// named export, щоб існуючі `const connectDB = require('./config/db')`
// (server.js, seed.js) лишились робочими без змін.
connectDB.close = () => mongoose.connection.close();

module.exports = connectDB;