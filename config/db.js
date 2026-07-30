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

module.exports = connectDB;