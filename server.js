// server.js (License + Products API)
// Robust version that can read the correct MongoDB database/collection
// even when the connection URI or deployment environment is inconsistent.

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = (process.env.ADMIN_API_KEY || '27168').toString().trim();
const MONGO_URI = (process.env.MONGO_URI || 'mongodb+srv://user:pass@cluster.mongodb.net/test').toString().trim();

app.use(cors());
app.use(express.json());

function getDbNameFromUri(uri) {
  try {
    const parsed = new URL(uri);
    const pathname = (parsed.pathname || '').replace(/^\/+/, '').trim();
    return pathname || 'test';
  } catch (err) {
    return 'test';
  }
}

const PREFERRED_DB_NAME = getDbNameFromUri(MONGO_URI);

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB database connected successfully!');
    console.log('Preferred DB name:', PREFERRED_DB_NAME);
  })
  .catch(err => console.error('MongoDB connection error:', err));

async function ensureConnected() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connection.asPromise();
  }
}

function requireAdmin(req, res, next) {
  const apiKey = (req.headers['x-api-key'] || '').toString().trim();
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

function buildExpiry(activatedOn, durationDays) {
  if (!activatedOn || !durationDays) return null;
  const start = new Date(activatedOn);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + (Number(durationDays) * 24 * 60 * 60 * 1000));
}

async function getCandidateDbs() {
  await ensureConnected();

  const client = mongoose.connection.getClient ? mongoose.connection.getClient() : mongoose.connection.client;
  const names = new Set();

  const connectedName = mongoose.connection.db && mongoose.connection.db.databaseName;
  if (connectedName) names.add(connectedName);

  if (PREFERRED_DB_NAME) names.add(PREFERRED_DB_NAME);
  names.add('test');

  return Array.from(names)
    .filter(Boolean)
    .map((name) => client.db(name));
}

async function findLicenseByKey(key) {
  const dbs = await getCandidateDbs();
  for (const db of dbs) {
    const license = await db.collection('licenses').findOne({ key });
    if (license) return { db, license };
  }
  return { db: null, license: null };
}

async function listLicensesAcrossDbs() {
  const dbs = await getCandidateDbs();
  const seen = new Set();
  const out = [];

  for (const db of dbs) {
    const docs = await db.collection('licenses').find({}).toArray();
    for (const doc of docs) {
      const id = doc?._id?.toString?.() || JSON.stringify(doc);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(doc);
    }
  }

  return out;
}

async function listProductsAcrossDbs() {
  const dbs = await getCandidateDbs();
  const seen = new Set();
  const out = [];

  for (const db of dbs) {
    const docs = await db.collection('products').find({}).sort({ sortOrder: 1, updatedAt: -1, _id: 1 }).toArray();
    for (const doc of docs) {
      const id = doc?._id?.toString?.() || JSON.stringify(doc);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(doc);
    }
  }

  return out;
}

async function findProductByIdAcrossDbs(id) {
  const dbs = await getCandidateDbs();
  if (!mongoose.Types.ObjectId.isValid(id)) return { db: null, product: null, objectId: null };
  const objectId = new mongoose.Types.ObjectId(id);

  for (const db of dbs) {
    const product = await db.collection('products').findOne({ _id: objectId });
    if (product) return { db, product, objectId };
  }

  return { db: null, product: null, objectId };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Public debug route to verify what database the server can see.
app.get('/api/debug/db-info', async (req, res) => {
  try {
    const dbs = await getCandidateDbs();
    const info = [];
    for (const db of dbs) {
      const [products, licenses] = await Promise.all([
        db.collection('products').countDocuments({}),
        db.collection('licenses').countDocuments({}),
      ]);
      info.push({ db: db.databaseName, products, licenses });
    }
    res.json({
      connected: mongoose.connection.readyState === 1,
      preferredDbName: PREFERRED_DB_NAME,
      envDbName: PREFERRED_DB_NAME,
      databases: info,
    });
  } catch (error) {
    console.error('Debug DB info error:', error);
    res.status(500).json({ message: 'Failed to read db info' });
  }
});

// --- License Activation Endpoint ---
app.post('/api/activate', async (req, res) => {
  const licenseKey = readLicenseKey(req.body);
  const deviceId = readDeviceId(req.body);

  if (!licenseKey || !deviceId) {
    return res.status(400).json({ message: 'License key and device ID are required.' });
  }

  try {
    const result = await findLicenseByKey(licenseKey);
    const license = result.license;
    const db = result.db;

    if (!license) {
      return res.status(404).json({ message: 'License key not found or invalid.' });
    }

    if (license.device_id && license.device_id !== deviceId) {
      return res.status(403).json({ message: 'This license key is already in use on another device.' });
    }

    const activatedOn = license.activated_on || new Date();
    const deviceToStore = license.device_id || deviceId;

    const expiry = buildExpiry(activatedOn, license.duration_days);
    if (expiry && new Date() > expiry) {
      return res.status(403).json({ message: 'This license has already expired.' });
    }

    await db.collection('licenses').updateOne(
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
    const result = await findLicenseByKey(licenseKey);
    const license = result.license;

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
    const result = await findLicenseByKey(licenseKey);
    if (!result.license || !result.db) {
      return res.status(404).json({ message: 'License key not found.' });
    }

    await result.db.collection('licenses').updateOne(
      { _id: result.license._id },
      { $set: { device_id: null, activated_on: null } }
    );

    return res.status(200).json({ message: `License ${licenseKey} has been successfully deactivated.` });
  } catch (error) {
    console.error('Deactivation Error:', error);
    return res.status(500).json({ message: 'Server error during deactivation.' });
  }
});

// --- Admin Endpoint: Get status of all keys ---
app.get('/api/status', requireAdmin, async (req, res) => {
  try {
    const allLicenses = await listLicensesAcrossDbs();
    return res.status(200).json(allLicenses);
  } catch (error) {
    console.error('Status Fetch Error:', error);
    return res.status(500).json({ message: 'Server error while fetching status.' });
  }
});

// --- Public products endpoint ---
app.get('/api/products', async (req, res) => {
  try {
    const list = await listProductsAcrossDbs();

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

    const dbs = await getCandidateDbs();
    const db = dbs[0];
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

    const result = await db.collection('products').insertOne(doc);
    return res.json({ ...doc, _id: result.insertedId, id: result.insertedId });
  } catch (error) {
    console.error('Create Product Error:', error);
    return res.status(500).json({ message: 'Create failed' });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const result = await findProductByIdAcrossDbs(req.params.id);
    if (!result.product || !result.db) {
      return res.status(404).json({ message: 'Product not found.' });
    }

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

    await result.db.collection('products').updateOne(
      { _id: result.objectId },
      { $set: update }
    );

    const updated = await result.db.collection('products').findOne({ _id: result.objectId });
    return res.json(updated);
  } catch (error) {
    console.error('Update Product Error:', error);
    return res.status(500).json({ message: 'Update failed' });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const result = await findProductByIdAcrossDbs(req.params.id);
    if (!result.product || !result.db) {
      return res.status(404).json({ message: 'Product not found.' });
    }

    const deleted = await result.db.collection('products').deleteOne({ _id: result.objectId });
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
    const dbs = await getCandidateDbs();
    const details = [];
    for (const db of dbs) {
      const total = await db.collection('products').countDocuments({});
      const active = await db.collection('products').countDocuments({ active: true });
      const inactive = await db.collection('products').countDocuments({ active: false });
      details.push({ db: db.databaseName, total, active, inactive });
    }
    return res.json({
      preferredDbName: PREFERRED_DB_NAME,
      details,
    });
  } catch (error) {
    console.error('Debug products count error:', error);
    return res.status(500).json({ message: 'Failed to count products' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
