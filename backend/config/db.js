const mongoose = require('mongoose');

let connectPromise = null;

// Fail fast when Mongo is not connected instead of buffering operations.
mongoose.set('bufferCommands', false);

const connectDB = async () => {
    if (mongoose.connection.readyState === 1) {
        return mongoose.connection;
    }
    if (connectPromise) {
        return connectPromise;
    }

    const mongoUri = String(process.env.MONGO_URI || '').trim();
    if (!mongoUri) {
        throw new Error('MONGO_URI is not configured');
    }

    connectPromise = mongoose.connect(mongoUri, {
        // Options for robustness
        serverSelectionTimeoutMS: 5000, // Fail fast if DB is down
        socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
    }).then((conn) => {
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
        return conn.connection;
    }).catch((error) => {
        connectPromise = null;
        console.error(`❌ MongoDB Connection Error: ${error.message}`);
        throw error;
    });

    return connectPromise;
};

module.exports = connectDB;
