
// server.js (License + Products API)

// A safer, explicit server that uses fixed MongoDB collections:
// - licenses
// - products
// It supports both `licenseKey` and `key` request fields so the
// extension and MongoDB screenshots can use the same data model.

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '27168';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://user:pass@cluster.mongodb.net/dbname';

app.use(cors());
app.use(express.json());

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('MongoDB database connected successfully!'))
  .catch(err => console.error('MongoDB connection error:', err));

async function getDb() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connection.asPromise();
  }
  return mongoose.connection.db;
}

function requireAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ message: 'Unauthorized: Admin API key is missing or incorrect.' });
  }
  next();
}

function readLicenseKey(body = {}) {
  return (
    body.licenseKey ||
    body.key ||
    body.license_key ||
    body.licensekey ||
    ''
  ).toString().trim();
}

function readDeviceId(body = {}) {
  return (
    body.deviceId ||
    body.device_id ||
    body.deviceID ||
    body.deviceid ||
    ''
  ).toString().trim();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function licensesCollection() {
  const db = await getDb();
  return db.collection('licenses');
}

async function productsCollection() {
  const db = await getDb();
  return db.collection('products');
}

function buildExpiry(activatedOn, durationDays) {
  if (!activatedOn || !durationDays) return null;
  const start = new Date(activatedOn);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + (Number(durationDays) * 24 * 60 * 60 * 1000));
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// --- License Activation Endpoint ---
app.post('/api/activate', async (req, res) => {
  const licenseKey = readLicenseKey(req.body);
  const deviceId = readDeviceId(req.body);

  if (!licenseKey || !deviceId) {
    return res.status(400).json({ message: 'License key and device ID are required.' });
  }

  try {
    const licenses = await licensesCollection();
    const license = await licenses.findOne({ key: licenseKey });

    if (!license) {
      return res.status(404).json({ message: 'License key not found or invalid.' });
    }

    if (license.device_id && license.device_id !== deviceId) {
      return res.status(403).json({ message: 'This license key is already in use on another device.' });
    }

    // If the key is already activated on this device, keep it as-is.
    // Otherwise bind it to the current device and set activation time.
    let activatedOn = license.activated_on || new Date();
    let deviceToStore = license.device_id || deviceId;

    const expiry = buildExpiry(activatedOn, license.duration_days);
    if (expiry && new Date() > expiry) {
      return res.status(403).json({ message: 'This license has already expired.' });
    }

    await licenses.updateOne(
      { _id: license._id },
      {
        $set: {
          device_id: deviceToStore,
          activated_on: activatedOn,
        },
      }
    );

    return res.status(200).json({
      message: 'License activated successfully!',
      licenseKey: license.key,
      expiresOn: expiry ? expiry.toISOString() : null,
    });
  } catch (error) {
    console.error('Activation Error:', error);
    return res.status(500).json({ message: 'Server error during activation.' });
  }
});

// --- License Validation Endpoint ---
app.post('/api/validate', async (req, res) => {
  const licenseKey = readLicenseKey(req.body);
  const deviceId = readDeviceId(req.body);

  if (!licenseKey || !deviceId) {
    return res.status(200).json({ valid: false, message: 'Missing information.' });
  }

  try {
    const licenses = await licensesCollection();
    const license = await licenses.findOne({ key: licenseKey });

    if (!license) {
      return res.status(200).json({ valid: false, message: 'Invalid or deactivated license.' });
    }

    if (!license.device_id || license.device_id !== deviceId || !license.activated_on) {
      return res.status(200).json({ valid: false, message: 'Invalid or deactivated license.' });
    }

    const expiresOn = buildExpiry(license.activated_on, license.duration_days);
    if (expiresOn && new Date() > expiresOn) {
      return res.status(200).json({ valid: false, message: 'License expired.' });
    }

    return res.status(200).json({
      valid: true,
      expiresOn: expiresOn ? expiresOn.toISOString() : null,
      licenseKey: license.key,
    });
  } catch (error) {
    console.error('Validation Error:', error);
    return res.status(500).json({ valid: false, message: 'Server error during validation.' });
  }
});

// --- Admin Endpoint: Deactivate a key ---
app.post('/api/deactivate', requireAdmin, async (req, res) => {
  const licenseKey = readLicenseKey(req.body);
  if (!licenseKey) {
    return res.status(400).json({ message: 'License key is required to deactivate.' });
  }

  try {
    const licenses = await licensesCollection();
    const result = await licenses.findOneAndUpdate(
      { key: licenseKey },
      { $set: { device_id: null, activated_on: null } },
      { returnDocument: 'after' }
    );

    if (!result || !result.value) {
      return res.status(404).json({ message: 'License key not found.' });
    }

    return res.status(200).json({ message: `License ${licenseKey} has been successfully deactivated.` });
  } catch (error) {
    console.error('Deactivation Error:', error);
    return res.status(500).json({ message: 'Server error during deactivation.' });
  }
});

// --- Admin Endpoint: Get status of all keys ---
app.get('/api/status', requireAdmin, async (req, res) => {
  try {
    const licenses = await licensesCollection();
    const allLicenses = await licenses.find({}).toArray();
    return res.status(200).json(allLicenses);
  } catch (error) {
    console.error('Status Fetch Error:', error);
    return res.status(500).json({ message: 'Server error while fetching status.' });
  }
});

// --- Public products endpoint ---
app.get('/api/products', async (req, res) => {
  try {
    const products = await productsCollection();

    // Return every product document so the UI can show active ones
    // and also reserve placeholders for inactive or partial entries.
    const list = await products
      .find({})
      .sort({ sortOrder: 1, updatedAt: -1, _id: 1 })
      .toArray();

    return res.json({
      products: list.map(p => ({
        _id: p._id,
        id: p._id,
        name: p.name || '',
        price: p.price || '',
        image: p.image || '',
        buyLink: p.buyLink || '#',
        active: p.active !== false,
        sortOrder: toInt(p.sortOrder, 0),
        description: p.description || '',
        updatedAt: p.updatedAt || null,
      })),
      count: list.length,
    });
  } catch (error) {
    console.error('Products Fetch Error:', error);
    return res.status(500).json({ message: 'Failed to fetch products' });
  }
});

// --- Admin create product ---
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const { name, price, image, buyLink, active, sortOrder, description } = req.body;

    if (!name || !price || !image) {
      return res.status(400).json({ message: 'name, price, and image are required.' });
    }

    const products = await productsCollection();
    const doc = {
      name: String(name).trim(),
      price: String(price).trim(),
      image: String(image).trim(),
      buyLink: buyLink ? String(buyLink).trim() : '#',
      description: description ? String(description).trim() : '',
      active: typeof active === 'boolean' ? active : true,
      sortOrder: toInt(sortOrder, 0),
      updatedAt: new Date(),
    };

    const result = await products.insertOne(doc);
    return res.json({ ...doc, _id: result.insertedId, id: result.insertedId });
  } catch (error) {
    console.error('Create Product Error:', error);
    return res.status(500).json({ message: 'Create failed' });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const products = await productsCollection();
    const update = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(update, 'sortOrder')) {
      update.sortOrder = toInt(update.sortOrder, 0);
    }
    if (Object.prototype.hasOwnProperty.call(update, 'name')) update.name = String(update.name).trim();
    if (Object.prototype.hasOwnProperty.call(update, 'price')) update.price = String(update.price).trim();
    if (Object.prototype.hasOwnProperty.call(update, 'image')) update.image = String(update.image).trim();
    if (Object.prototype.hasOwnProperty.call(update, 'buyLink')) update.buyLink = String(update.buyLink).trim();
    if (Object.prototype.hasOwnProperty.call(update, 'description')) update.description = String(update.description).trim();
    update.updatedAt = new Date();

    const result = await products.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(req.params.id) },
      { $set: update },
      { returnDocument: 'after' }
    );

    if (!result || !result.value) {
      return res.status(404).json({ message: 'Product not found.' });
    }

    return res.json(result.value);
  } catch (error) {
    console.error('Update Product Error:', error);
    return res.status(500).json({ message: 'Update failed' });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const products = await productsCollection();
    const deleted = await products.deleteOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!deleted.deletedCount) {
      return res.status(404).json({ message: 'Product not found.' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Delete Product Error:', error);
    return res.status(500).json({ message: 'Delete failed' });
  }
});


app.get('/api/debug/products-count', requireAdmin, async (req, res) => {
  try {
    const products = await productsCollection();
    const total = await products.countDocuments({});
    const active = await products.countDocuments({ active: true });
    const inactive = await products.countDocuments({ active: false });
    return res.json({ total, active, inactive });
  } catch (error) {
    console.error('Debug products count error:', error);
    return res.status(500).json({ message: 'Failed to count products' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
