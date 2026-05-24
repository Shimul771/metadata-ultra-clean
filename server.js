// server.js (License + Products API)

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '27168';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://user:pass@cluster.mongodb.net/dbname';

app.use(cors());
app.use(express.json());

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB database connected successfully!'))
  .catch(err => console.error('MongoDB connection error:', err));

const licenseSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  duration_days: { type: Number, required: true },
  activated_on: { type: Date, default: null },
  device_id: { type: String, default: null }
});

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  price: { type: String, required: true, trim: true },
  image: { type: String, required: true, trim: true },
  buyLink: { type: String, default: '#', trim: true },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

const License = mongoose.model('License', licenseSchema);
const Product = mongoose.model('Product', productSchema);

function requireAdmin(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ message: 'Unauthorized: Admin API key is missing or incorrect.' });
  }
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// --- License Activation Endpoint ---
app.post('/api/activate', async (req, res) => {
  const { licenseKey, deviceId } = req.body;
  if (!licenseKey || !deviceId) {
    return res.status(400).json({ message: 'License key and device ID are required.' });
  }

  try {
    const license = await License.findOne({ key: licenseKey });

    if (!license) {
      return res.status(404).json({ message: 'License key not found or invalid.' });
    }
    if (license.device_id && license.device_id !== deviceId) {
      return res.status(403).json({ message: 'This license key is already in use on another device.' });
    }

    const expiresOnCheck = license.activated_on
      ? new Date(license.activated_on.getTime() + (license.duration_days * 24 * 60 * 60 * 1000))
      : null;

    if (expiresOnCheck && new Date() > expiresOnCheck) {
      return res.status(403).json({ message: 'This license has already expired.' });
    }

    if (!license.device_id) {
      license.device_id = deviceId;
      license.activated_on = new Date();
      await license.save();
    }

    const expiresOn = new Date(license.activated_on.getTime() + (license.duration_days * 24 * 60 * 60 * 1000));

    res.status(200).json({
      message: 'License activated successfully!',
      licenseKey: license.key,
      expiresOn: expiresOn.toISOString()
    });
  } catch (error) {
    console.error('Activation Error:', error);
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
    console.error('Validation Error:', error);
    res.status(500).json({ valid: false, message: 'Server error during validation.' });
  }
});

// --- Admin Endpoint: Deactivate a key ---
app.post('/api/deactivate', requireAdmin, async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) {
    return res.status(400).json({ message: 'License key is required to deactivate.' });
  }

  try {
    const license = await License.findOneAndUpdate(
      { key: licenseKey },
      { $set: { device_id: null, activated_on: null } },
      { new: true }
    );

    if (!license) {
      return res.status(404).json({ message: 'License key not found.' });
    }

    res.status(200).json({ message: `License ${licenseKey} has been successfully deactivated.` });
  } catch (error) {
    console.error('Deactivation Error:', error);
    res.status(500).json({ message: 'Server error during deactivation.' });
  }
});

// --- Admin Endpoint: Get status of all keys ---
app.get('/api/status', requireAdmin, async (req, res) => {
  try {
    const allLicenses = await License.find({});
    res.status(200).json(allLicenses);
  } catch (error) {
    console.error('Status Fetch Error:', error);
    res.status(500).json({ message: 'Server error while fetching status.' });
  }
});

// --- Public products endpoint ---
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find({ active: true }).sort({ sortOrder: 1, updatedAt: -1 });
    res.json({ products });
  } catch (error) {
    console.error('Products Fetch Error:', error);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
});

// --- Admin create product ---
app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const { name, price, image, buyLink, active, sortOrder } = req.body;

    if (!name || !price || !image) {
      return res.status(400).json({ message: 'name, price, and image are required.' });
    }

    const p = await Product.create({
      name,
      price,
      image,
      buyLink: buyLink || '#',
      active: typeof active === 'boolean' ? active : true,
      sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
    });

    res.json(p);
  } catch (error) {
    console.error('Create Product Error:', error);
    res.status(500).json({ message: 'Create failed' });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const update = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(update, 'sortOrder')) {
      update.sortOrder = Number.isFinite(Number(update.sortOrder)) ? Number(update.sortOrder) : 0;
    }
    const p = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!p) return res.status(404).json({ message: 'Product not found.' });
    res.json(p);
  } catch (error) {
    console.error('Update Product Error:', error);
    res.status(500).json({ message: 'Update failed' });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Product not found.' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete Product Error:', error);
    res.status(500).json({ message: 'Delete failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
