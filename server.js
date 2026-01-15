// server.js (Final Version for MongoDB)

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose'); // ডাটাবেসের সাথে সংযোগের জন্য Mongoose লাইব্রেরি
const app = express();

// Render থেকে পোর্ট নম্বর অটোমেটিক পাওয়ার জন্য || অথবা লোকালভাবে চালানোর জন্য 3000
const PORT = process.env.PORT || 3000;

// <<< গুরুত্বপূর্ণ >>> ADMIN_API_KEY অবশ্যই পরিবর্তন করে একটি কঠিন পাসওয়ার্ড দিন
const ADMIN_API_KEY = '27168'; 

app.use(cors());
app.use(express.json());

// --- Step 1: MongoDB Connection ---
// <<< গুরুত্বপূর্ণ >>> এই কানেকশন স্ট্রিংটি সরাসরি কোডে না রেখে Render-এর Environment Variable-এ রাখুন
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://user:pass@cluster.mongodb.net/dbname';

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB database connected successfully!'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Step 2: Create a Schema and Model ---
// ডাটাবেসে লাইসেন্সের তথ্য কী ফরম্যাটে সেভ হবে, তার একটি কাঠামো বা Schema
const licenseSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // লাইসেন্স কী, এটি ইউনিক হতে হবে
    duration_days: { type: Number, required: true },
    activated_on: { type: Date, default: null },
    device_id: { type: String, default: null }
});

// Schema থেকে Model তৈরি করা হলো, যা দিয়ে আমরা ডাটাবেসে Query চালাবো
const License = mongoose.model('License', licenseSchema);


// ===================================================================
// API Endpoints
// ===================================================================

// --- License Activation Endpoint ---
app.post('/api/activate', async (req, res) => {
    const { licenseKey, deviceId } = req.body;
    if (!licenseKey || !deviceId) {
        return res.status(400).json({ message: 'License key and device ID are required.' });
    }

    try {
        // ডাটাবেস থেকে লাইসেন্স কী'টি খোঁজা হচ্ছে
        const license = await License.findOne({ key: licenseKey });

        if (!license) {
            return res.status(404).json({ message: 'License key not found or invalid.' });
        }
        if (license.device_id && license.device_id !== deviceId) {
            return res.status(403).json({ message: 'This license key is already in use on another device.' });
        }
        
        const expiresOnCheck = license.activated_on ? new Date(license.activated_on.getTime() + (license.duration_days * 24 * 60 * 60 * 1000)) : null;
        if (expiresOnCheck && new Date() > expiresOnCheck) {
             return res.status(403).json({ message: 'This license has already expired.' });
        }
        
        // যদি প্রথমবার অ্যাক্টিভেট হয়, তাহলে তথ্য আপডেট করা হচ্ছে
        if (!license.device_id) {
            license.device_id = deviceId;
            license.activated_on = new Date();
            await license.save(); // পরিবর্তনটি ডাটাবেসে সেভ করা হচ্ছে
        }

        const expiresOn = new Date(license.activated_on.getTime() + (license.duration_days * 24 * 60 * 60 * 1000));
        
        res.status(200).json({
            message: 'License activated successfully!',
            licenseKey: license.key,
            expiresOn: expiresOn.toISOString()
        });

    } catch (error) {
        console.error("Activation Error:", error);
        res.status(500).json({ message: 'Server error during activation.' });
    }
});

// --- License Validation Endpoint ---
app.post('/api/validate', async (req, res) => {
    const { licenseKey, deviceId } = req.body;
    if (!licenseKey || !deviceId) {
        return res.status(200).json({ valid: false, message: 'Missing information.' });
    }

    try {
        const license = await License.findOne({ key: licenseKey });

        if (!license || license.device_id !== deviceId || !license.activated_on) {
            return res.status(200).json({ valid: false, message: 'Invalid or deactivated license.' });
        }

        const expiresOn = new Date(license.activated_on.getTime() + (license.duration_days * 24 * 60 * 60 * 1000));
        if (new Date() > expiresOn) {
            return res.status(200).json({ valid: false, message: 'License expired.' });
        }

        return res.status(200).json({ valid: true });

    } catch (error) {
        console.error("Validation Error:", error);
        res.status(500).json({ valid: false, message: 'Server error during validation.' });
    }
});

// --- Admin Endpoint: Deactivate a key ---
app.post('/api/deactivate', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== ADMIN_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized: Admin API key is missing or incorrect.' });
    }

    const { licenseKey } = req.body;
    if (!licenseKey) {
        return res.status(400).json({ message: 'License key is required to deactivate.' });
    }
    
    try {
        const license = await License.findOneAndUpdate(
            { key: licenseKey },
            { $set: { device_id: null, activated_on: null } }, // রিসেট করা হচ্ছে
            { new: true }
        );

        if (!license) {
            return res.status(404).json({ message: 'License key not found.' });
        }

        console.log(`License ${licenseKey} has been deactivated by an admin.`);
        res.status(200).json({ message: `License ${licenseKey} has been successfully deactivated.` });

    } catch (error) {
        console.error("Deactivation Error:", error);
        res.status(500).json({ message: 'Server error during deactivation.' });
    }
});

// --- Admin Endpoint: Get status of all keys ---
app.get('/api/status', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== ADMIN_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized: Admin API key is missing or incorrect.' });
    }

    try {
        const allLicenses = await License.find({}); // ডাটাবেস থেকে সব লাইসেন্স আনা হচ্ছে
        res.status(200).json(allLicenses);
    } catch (error) {
        console.error("Status Fetch Error:", error);
        res.status(500).json({ message: 'Server error while fetching status.' });
    }
});


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});