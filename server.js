// server.js (License + Products API)
// Robust version that can read the correct MongoDB database/collection
// even when the connection URI or deployment environment is inconsistent.

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = (process.env.ADMIN_API_KEY || '27168').toString().trim();
const MONGO_URI = (process.env.MONGO_URI || 'mongodb+srv://user:pass@cluster.mongodb.net/test').toString().trim();
const BOT_TOKEN = (process.env.BOT_TOKEN || '').toString().trim();
const DEFAULT_BUY_LICENSE_URL = 'https://web.whatsapp.com/send/?phone=1964719770';
const TG_ADMIN_IDS = (process.env.TG_ADMIN_IDS || '')
  .toString()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
  const authHeader = (req.headers.authorization || '').toString().trim();
  const bearerKey = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const apiKey = (req.headers['x-api-key'] || req.headers['x-admin-key'] || bearerKey || '').toString().trim();
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

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((v) => parseInt(v, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((v) => parseInt(v, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function daysUntil(dateValue) {
  if (!dateValue) return null;
  const time = new Date(dateValue).getTime();
  if (Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / (24 * 60 * 60 * 1000));
}

function getLicensePromoHidden(license = {}) {
  return license.hideAiToolsPromo === true ||
    license.hide_ai_tools_promo === true ||
    license.hideAiToolsInExpiryPopup === true ||
    license.showAiToolsInExpiryPopup === false;
}

function getEnvExtensionSettings() {
  return {
    buyLicenseUrl: (process.env.BUY_LICENSE_URL || process.env.WHATSAPP_BUY_LICENSE_URL || DEFAULT_BUY_LICENSE_URL).toString().trim(),
    expiryWarningDays: toInt(process.env.EXPIRY_WARNING_DAYS, 6),
  };
}

function getEnvUpdateConfig() {
  return {
    enabled: toBool(process.env.EXTENSION_UPDATE_ENABLED, false),
    latestVersion: (process.env.EXTENSION_LATEST_VERSION || '').toString().trim(),
    updateUrl: (process.env.EXTENSION_UPDATE_URL || '').toString().trim(),
    howToUpdate: (process.env.EXTENSION_HOW_TO_UPDATE || '').toString().trim(),
    forceUpdate: toBool(process.env.EXTENSION_FORCE_UPDATE, true),
  };
}

function isTelegramAdmin(telegramUserId) {
  if (!TG_ADMIN_IDS.length) return false;
  return TG_ADMIN_IDS.includes(String(telegramUserId));
}

function makeSecureLicenseKey(groups = 5, charsPerGroup = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(groups * charsPerGroup);
  const parts = [];
  let cursor = 0;

  for (let g = 0; g < groups; g += 1) {
    let piece = '';
    for (let c = 0; c < charsPerGroup; c += 1) {
      piece += alphabet[bytes[cursor] % alphabet.length];
      cursor += 1;
    }
    parts.push(piece);
  }

  return parts.join('-');
}


function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePipeArgs(raw = '') {
  return String(raw).split('|').map((part) => part.trim());
}

function normalizeLicenseKey(key = '') {
  return String(key).trim().toUpperCase();
}

function parseDays(value, fallback = 30) {
  const days = parseInt(value, 10);
  return Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : fallback;
}

function formatDateTime(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatMoneyText(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

function formatLicenseForTelegram(license = {}) {
  const expiresOn = buildExpiry(license.activated_on, license.duration_days);
  const daysLeft = expiresOn ? daysUntil(expiresOn) : null;
  const hidden = getLicensePromoHidden(license);
  return [
    `Key: ${license.key || '-'}`,
    `Duration: ${license.duration_days || '-'} days`,
    `Activated: ${formatDateTime(license.activated_on)}`,
    `Expires: ${expiresOn ? formatDateTime(expiresOn) : 'Not activated yet'}`,
    `Days left: ${daysLeft === null ? '-' : daysLeft}`,
    `Device: ${license.device_id || 'Not bound'}`,
    `AI Tools hidden: ${hidden ? 'YES' : 'NO'}`,
  ].join('\n');
}

function formatProductForTelegram(product = {}) {
  return [
    `ID: ${product._id?.toString?.() || product.id || '-'}`,
    `Name: ${product.name || '-'}`,
    `Price: ${formatMoneyText(product.price)}`,
    `Active: ${product.active === false ? 'NO' : 'YES'}`,
    `Sort: ${toInt(product.sortOrder, 0)}`,
    `Image: ${product.image || '-'}`,
    `Buy: ${product.buyLink || '-'}`,
    product.description ? `Description: ${product.description}` : null,
  ].filter(Boolean).join('\n');
}

async function findProductByQueryAcrossDbs(query) {
  const value = String(query || '').trim();
  if (!value) return { db: null, product: null, objectId: null };
  if (mongoose.Types.ObjectId.isValid(value)) {
    return findProductByIdAcrossDbs(value);
  }
  const dbs = await getCandidateDbs();
  const exact = new RegExp(`^${escapeRegex(value)}$`, 'i');
  for (const db of dbs) {
    const product = await db.collection('products').findOne({ name: exact });
    if (product) return { db, product, objectId: product._id };
  }
  const loose = new RegExp(escapeRegex(value), 'i');
  for (const db of dbs) {
    const product = await db.collection('products').findOne({ name: loose });
    if (product) return { db, product, objectId: product._id };
  }
  return { db: null, product: null, objectId: null };
}

async function createLicenseKeys(count, days, options = {}) {
  const db = await getPrimaryDb();
  const keys = [];
  const hideAiToolsPromo = options.hideAiToolsPromo === true;

  for (let i = 0; i < count; i += 1) {
    let key = makeSecureLicenseKey();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await db.collection('licenses').findOne({ key });
      if (!exists) break;
      key = makeSecureLicenseKey();
    }

    // eslint-disable-next-line no-await-in-loop
    await db.collection('licenses').insertOne({
      key,
      duration_days: days,
      activated_on: null,
      device_id: null,
      hideAiToolsPromo,
      showAiToolsInExpiryPopup: !hideAiToolsPromo,
      created_at: new Date(),
      source: options.source || 'telegram',
    });
    keys.push(key);
  }

  return keys;
}

async function updateLicensePromoFlag(key, hideAiToolsPromo) {
  const result = await findLicenseByKey(normalizeLicenseKey(key));
  if (!result.license || !result.db) return null;
  await result.db.collection('licenses').updateOne(
    { _id: result.license._id },
    { $set: { hideAiToolsPromo, showAiToolsInExpiryPopup: !hideAiToolsPromo, updated_at: new Date() } }
  );
  return { ...result.license, hideAiToolsPromo, showAiToolsInExpiryPopup: !hideAiToolsPromo };
}


async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

async function sendTelegramChunked(chatId, text) {
  const limit = 3800;
  const chunks = [];
  let current = '';

  for (const line of String(text).split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    await sendTelegramMessage(chatId, chunk);
  }
}

async function getPrimaryDb() {

  await ensureConnected();
  const client = mongoose.connection.getClient ? mongoose.connection.getClient() : mongoose.connection.client;
  return client.db(PREFERRED_DB_NAME || 'test');
}

async function startTelegramBot() {
  if (!BOT_TOKEN) {
    console.log('Telegram bot is disabled: BOT_TOKEN not provided.');
    return;
  }

  if (!TG_ADMIN_IDS.length) {
    console.log('Telegram bot is disabled: TG_ADMIN_IDS not provided.');
    return;
  }

  console.log('Telegram bot enabled for admin IDs:', TG_ADMIN_IDS.join(', '));

  let offset = 0;
  let polling = false;

  const helpText = [
    'Ideomotion Admin Bot Commands',
    '',
    'License:',
    '/gen COUNT DAYS — generate license keys',
    '/genhidden COUNT DAYS — generate keys with AI Tools hidden',
    '/license KEY — show one license status',
    '/searchlicense TEXT — search license keys',
    '/resetlicense KEY — unbind device only',
    '/deactivate KEY — unbind device and activation date',
    '/dellicense KEY — permanently delete license',
    '/extend KEY DAYS — add days to license duration',
    '/setdays KEY DAYS — set duration days',
    '/hideaitools KEY — hide AI Tools/promo/bell for this license',
    '/showaitools KEY — show AI Tools/promo/bell for this license',
    '',
    'Products:',
    '/productlist — list products',
    '/productadd name | price | imageUrl | buyLink | description | sortOrder',
    '/productremove ID_OR_NAME — permanently delete product',
    '/productoff ID_OR_NAME — hide product',
    '/producton ID_OR_NAME — show product',
    '/productprice ID_OR_NAME | new price',
    '/productlink ID_OR_NAME | new buy link',
    '',
    'Extension settings:',
    '/setwhatsapp URL — set Buy License link',
    '/setexpirydays DAYS — set expiry popup threshold',
    '/settings — show extension settings',
    '',
    'Update control:',
    '/setupdate VERSION | UPDATE_URL | force:true/false | how to update text',
    '/updateon — enable update lock screen',
    '/updateoff — disable update lock screen',
    '/updatestatus — show update config',
    '',
    'Info:',
    '/stats — database counts',
    '/help — show commands',
  ].join('\n');

  const processUpdate = async (update) => {
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = msg.text.trim();

    if (!isTelegramAdmin(userId)) {
      await sendTelegramMessage(chatId, 'Unauthorized.');
      return;
    }

    try {
      if (/^\/(start|help)(?:@\w+)?$/i.test(text)) {
        await sendTelegramChunked(chatId, helpText);
        return;
      }

      const genMatch = text.match(/^\/gen(?:@\w+)?\s+(\d+)\s+(\d+)$/i);
      if (genMatch) {
        const count = Math.max(1, Math.min(200, parseInt(genMatch[1], 10) || 0));
        const days = Math.max(1, Math.min(3650, parseInt(genMatch[2], 10) || 0));
        const keys = await createLicenseKeys(count, days, { source: 'telegram', hideAiToolsPromo: false });
        await sendTelegramChunked(chatId, `Generated ${keys.length} license keys (${days} days):\n\n${keys.join('\n')}`);
        return;
      }

      const genHiddenMatch = text.match(/^\/genhidden(?:@\w+)?\s+(\d+)\s+(\d+)$/i);
      if (genHiddenMatch) {
        const count = Math.max(1, Math.min(200, parseInt(genHiddenMatch[1], 10) || 0));
        const days = Math.max(1, Math.min(3650, parseInt(genHiddenMatch[2], 10) || 0));
        const keys = await createLicenseKeys(count, days, { source: 'telegram', hideAiToolsPromo: true });
        await sendTelegramChunked(chatId, `Generated ${keys.length} hidden-AI-Tools license keys (${days} days):\n\n${keys.join('\n')}`);
        return;
      }

      const licenseMatch = text.match(/^\/license(?:@\w+)?\s+(.+)$/i);
      if (licenseMatch) {
        const key = normalizeLicenseKey(licenseMatch[1]);
        const result = await findLicenseByKey(key);
        if (!result.license) {
          await sendTelegramMessage(chatId, `License not found: ${key}`);
          return;
        }
        await sendTelegramMessage(chatId, formatLicenseForTelegram(result.license));
        return;
      }

      const searchLicenseMatch = text.match(/^\/searchlicense(?:@\w+)?\s+(.+)$/i);
      if (searchLicenseMatch) {
        const query = searchLicenseMatch[1].trim();
        const all = await listLicensesAcrossDbs();
        const found = all
          .filter((l) => String(l.key || '').toLowerCase().includes(query.toLowerCase()))
          .slice(0, 20);
        if (!found.length) {
          await sendTelegramMessage(chatId, `No license found for: ${query}`);
          return;
        }
        await sendTelegramChunked(chatId, found.map((l, i) => `${i + 1}. ${l.key} | ${l.duration_days || '-'} days | ${getLicensePromoHidden(l) ? 'AI hidden' : 'AI shown'}`).join('\n'));
        return;
      }

      const resetMatch = text.match(/^\/resetlicense(?:@\w+)?\s+(.+)$/i);
      if (resetMatch) {
        const key = normalizeLicenseKey(resetMatch[1]);
        const result = await findLicenseByKey(key);
        if (!result.license || !result.db) {
          await sendTelegramMessage(chatId, `License not found: ${key}`);
          return;
        }
        await result.db.collection('licenses').updateOne(
          { _id: result.license._id },
          { $set: { device_id: null, updated_at: new Date() } }
        );
        await sendTelegramMessage(chatId, `Device reset done for: ${key}`);
        return;
      }

      const deactivateMatch = text.match(/^\/deactivate(?:@\w+)?\s+(.+)$/i);
      if (deactivateMatch) {
        const key = normalizeLicenseKey(deactivateMatch[1]);
        const result = await findLicenseByKey(key);
        if (!result.license || !result.db) {
          await sendTelegramMessage(chatId, `License not found: ${key}`);
          return;
        }
        await result.db.collection('licenses').updateOne(
          { _id: result.license._id },
          { $set: { device_id: null, activated_on: null, deactivated_at: new Date(), updated_at: new Date() } }
        );
        await sendTelegramMessage(chatId, `License deactivated: ${key}`);
        return;
      }

      const deleteLicenseMatch = text.match(/^\/(dellicense|deletelicense|removelicense)(?:@\w+)?\s+(.+)$/i);
      if (deleteLicenseMatch) {
        const key = normalizeLicenseKey(deleteLicenseMatch[2]);
        const result = await findLicenseByKey(key);
        if (!result.license || !result.db) {
          await sendTelegramMessage(chatId, `License not found: ${key}`);
          return;
        }
        await result.db.collection('licenses').deleteOne({ _id: result.license._id });
        await sendTelegramMessage(chatId, `License permanently deleted: ${key}`);
        return;
      }

      const extendMatch = text.match(/^\/extend(?:@\w+)?\s+(\S+)\s+(\d+)$/i);
      if (extendMatch) {
        const key = normalizeLicenseKey(extendMatch[1]);
        const extraDays = parseDays(extendMatch[2], 0);
        const result = await findLicenseByKey(key);
        if (!result.license || !result.db) {
          await sendTelegramMessage(chatId, `License not found: ${key}`);
          return;
        }
        const nextDays = toInt(result.license.duration_days, 0) + extraDays;
        await result.db.collection('licenses').updateOne(
          { _id: result.license._id },
          { $set: { duration_days: nextDays, updated_at: new Date() } }
        );
        await sendTelegramMessage(chatId, `License extended: ${key}\nNew duration: ${nextDays} days`);
        return;
      }

      const setDaysMatch = text.match(/^\/setdays(?:@\w+)?\s+(\S+)\s+(\d+)$/i);
      if (setDaysMatch) {
        const key = normalizeLicenseKey(setDaysMatch[1]);
        const days = parseDays(setDaysMatch[2], 30);
        const result = await findLicenseByKey(key);
        if (!result.license || !result.db) {
          await sendTelegramMessage(chatId, `License not found: ${key}`);
          return;
        }
        await result.db.collection('licenses').updateOne(
          { _id: result.license._id },
          { $set: { duration_days: days, updated_at: new Date() } }
        );
        await sendTelegramMessage(chatId, `License duration set: ${key}\nDuration: ${days} days`);
        return;
      }

      const promoMatch = text.match(/^\/(hideaitools|showaitools)(?:@\w+)?\s+(.+)$/i);
      if (promoMatch) {
        const action = promoMatch[1].toLowerCase();
        const key = normalizeLicenseKey(promoMatch[2]);
        const hideAiToolsPromo = action === 'hideaitools';
        const updated = await updateLicensePromoFlag(key, hideAiToolsPromo);
        if (!updated) {
          await sendTelegramMessage(chatId, `License not found: ${key}`);
          return;
        }
        await sendTelegramMessage(chatId, `${hideAiToolsPromo ? 'Hidden' : 'Shown'} AI Tools / bell / promo for: ${key}`);
        return;
      }

      if (/^\/productlist(?:@\w+)?$/i.test(text)) {
        const products = await listProductsAcrossDbs();
        if (!products.length) {
          await sendTelegramMessage(chatId, 'No products found.');
          return;
        }
        await sendTelegramChunked(chatId, products.map((p, i) => `${i + 1}. ${p.active === false ? '[OFF]' : '[ON]'} ${p.name || '-'} — ${formatMoneyText(p.price)}\nID: ${p._id?.toString?.() || '-'}`).join('\n\n'));
        return;
      }

      const productAddMatch = text.match(/^\/productadd(?:@\w+)?\s+([\s\S]+)$/i);
      if (productAddMatch) {
        const [name, price, image, buyLink, description, sortOrder] = parsePipeArgs(productAddMatch[1]);
        if (!name || !price || !image) {
          await sendTelegramMessage(chatId, 'Use: /productadd name | price | imageUrl | buyLink | description | sortOrder');
          return;
        }
        const db = await getPrimaryDb();
        const doc = {
          name,
          price,
          image,
          buyLink: buyLink || '#',
          description: description || '',
          active: true,
          sortOrder: toInt(sortOrder, 0),
          updatedAt: new Date(),
          createdAt: new Date(),
          source: 'telegram',
        };
        const result = await db.collection('products').insertOne(doc);
        await sendTelegramMessage(chatId, `Product added.\n\n${formatProductForTelegram({ ...doc, _id: result.insertedId })}`);
        return;
      }

      const productRemoveMatch = text.match(/^\/(productremove|productdelete|delproduct)(?:@\w+)?\s+(.+)$/i);
      if (productRemoveMatch) {
        const query = productRemoveMatch[2].trim();
        const result = await findProductByQueryAcrossDbs(query);
        if (!result.product || !result.db) {
          await sendTelegramMessage(chatId, `Product not found: ${query}`);
          return;
        }
        await result.db.collection('products').deleteOne({ _id: result.objectId });
        await sendTelegramMessage(chatId, `Product deleted: ${result.product.name || query}`);
        return;
      }

      const productToggleMatch = text.match(/^\/(producton|productoff)(?:@\w+)?\s+(.+)$/i);
      if (productToggleMatch) {
        const active = productToggleMatch[1].toLowerCase() === 'producton';
        const query = productToggleMatch[2].trim();
        const result = await findProductByQueryAcrossDbs(query);
        if (!result.product || !result.db) {
          await sendTelegramMessage(chatId, `Product not found: ${query}`);
          return;
        }
        await result.db.collection('products').updateOne(
          { _id: result.objectId },
          { $set: { active, updatedAt: new Date() } }
        );
        await sendTelegramMessage(chatId, `Product ${active ? 'enabled' : 'hidden'}: ${result.product.name}`);
        return;
      }

      const productPriceMatch = text.match(/^\/productprice(?:@\w+)?\s+([\s\S]+)$/i);
      if (productPriceMatch) {
        const [query, price] = parsePipeArgs(productPriceMatch[1]);
        if (!query || !price) {
          await sendTelegramMessage(chatId, 'Use: /productprice ID_OR_NAME | new price');
          return;
        }
        const result = await findProductByQueryAcrossDbs(query);
        if (!result.product || !result.db) {
          await sendTelegramMessage(chatId, `Product not found: ${query}`);
          return;
        }
        await result.db.collection('products').updateOne(
          { _id: result.objectId },
          { $set: { price, updatedAt: new Date() } }
        );
        await sendTelegramMessage(chatId, `Product price updated: ${result.product.name}\nNew price: ${price}`);
        return;
      }

      const productLinkMatch = text.match(/^\/productlink(?:@\w+)?\s+([\s\S]+)$/i);
      if (productLinkMatch) {
        const [query, buyLink] = parsePipeArgs(productLinkMatch[1]);
        if (!query || !buyLink) {
          await sendTelegramMessage(chatId, 'Use: /productlink ID_OR_NAME | new buy link');
          return;
        }
        const result = await findProductByQueryAcrossDbs(query);
        if (!result.product || !result.db) {
          await sendTelegramMessage(chatId, `Product not found: ${query}`);
          return;
        }
        await result.db.collection('products').updateOne(
          { _id: result.objectId },
          { $set: { buyLink, updatedAt: new Date() } }
        );
        await sendTelegramMessage(chatId, `Product link updated: ${result.product.name}`);
        return;
      }

      const setWhatsAppMatch = text.match(/^\/setwhatsapp(?:@\w+)?\s+(.+)$/i);
      if (setWhatsAppMatch) {
        const url = setWhatsAppMatch[1].trim();
        const current = await getServerConfigDoc('extension_settings');
        const db = current.db || await getPrimaryDb();
        const previous = await getExtensionSettings();
        const doc = {
          key: 'extension_settings',
          buyLicenseUrl: url,
          expiryWarningDays: toInt(previous.expiryWarningDays, 6),
          updatedAt: new Date(),
        };
        await db.collection('server_config').updateOne({ key: 'extension_settings' }, { $set: doc }, { upsert: true });
        await sendTelegramMessage(chatId, `Buy License WhatsApp/link updated:\n${url}`);
        return;
      }

      const setExpiryMatch = text.match(/^\/setexpirydays(?:@\w+)?\s+(\d+)$/i);
      if (setExpiryMatch) {
        const days = Math.max(1, Math.min(365, parseInt(setExpiryMatch[1], 10) || 6));
        const current = await getServerConfigDoc('extension_settings');
        const db = current.db || await getPrimaryDb();
        const previous = await getExtensionSettings();
        const doc = {
          key: 'extension_settings',
          buyLicenseUrl: previous.buyLicenseUrl || DEFAULT_BUY_LICENSE_URL,
          expiryWarningDays: days,
          updatedAt: new Date(),
        };
        await db.collection('server_config').updateOne({ key: 'extension_settings' }, { $set: doc }, { upsert: true });
        await sendTelegramMessage(chatId, `Expiry popup threshold set to ${days} day(s).`);
        return;
      }

      if (/^\/settings(?:@\w+)?$/i.test(text)) {
        const settings = await getExtensionSettings();
        await sendTelegramMessage(chatId, `Extension settings:\nBuy License URL: ${settings.buyLicenseUrl || '-'}\nExpiry warning days: ${settings.expiryWarningDays}`);
        return;
      }

      const setUpdateMatch = text.match(/^\/setupdate(?:@\w+)?\s+([\s\S]+)$/i);
      if (setUpdateMatch) {
        const [latestVersion, updateUrl, forceText, ...howParts] = parsePipeArgs(setUpdateMatch[1]);
        if (!latestVersion || !updateUrl) {
          await sendTelegramMessage(chatId, 'Use: /setupdate VERSION | UPDATE_URL | force:true/false | how to update text');
          return;
        }
        const forceUpdate = /false|0|no|off/i.test(forceText || '') ? false : true;
        const howToUpdate = howParts.join(' | ').trim() || 'Download ZIP, open chrome://extensions, remove old version, extract new ZIP, then Load unpacked.';
        const current = await getServerConfigDoc('extension_update');
        const db = current.db || await getPrimaryDb();
        const doc = { key: 'extension_update', enabled: true, latestVersion, updateUrl, howToUpdate, forceUpdate, updatedAt: new Date() };
        await db.collection('server_config').updateOne({ key: 'extension_update' }, { $set: doc }, { upsert: true });
        await sendTelegramMessage(chatId, `Update config saved and enabled.\nLatest: ${latestVersion}\nForce: ${forceUpdate ? 'YES' : 'NO'}\nURL: ${updateUrl}`);
        return;
      }

      if (/^\/updateon(?:@\w+)?$/i.test(text) || /^\/updateoff(?:@\w+)?$/i.test(text)) {
        const enabled = /^\/updateon/i.test(text);
        const current = await getServerConfigDoc('extension_update');
        const db = current.db || await getPrimaryDb();
        const previous = await getExtensionUpdateConfig();
        const doc = { ...previous, key: 'extension_update', enabled, updatedAt: new Date() };
        await db.collection('server_config').updateOne({ key: 'extension_update' }, { $set: doc }, { upsert: true });
        await sendTelegramMessage(chatId, `Extension update lock screen ${enabled ? 'enabled' : 'disabled'}.`);
        return;
      }

      if (/^\/updatestatus(?:@\w+)?$/i.test(text)) {
        const config = await getExtensionUpdateConfig();
        await sendTelegramMessage(chatId, [
          'Extension update config:',
          `Enabled: ${config.enabled ? 'YES' : 'NO'}`,
          `Latest version: ${config.latestVersion || '-'}`,
          `Update URL: ${config.updateUrl || '-'}`,
          `Force update: ${config.forceUpdate === false ? 'NO' : 'YES'}`,
          `How to update: ${config.howToUpdate || '-'}`,
        ].join('\n'));
        return;
      }

      if (/^\/stats(?:@\w+)?$/i.test(text)) {
        const dbs = await getCandidateDbs();
        const lines = [];
        for (const db of dbs) {
          // eslint-disable-next-line no-await-in-loop
          const licenses = await db.collection('licenses').countDocuments({});
          // eslint-disable-next-line no-await-in-loop
          const products = await db.collection('products').countDocuments({});
          // eslint-disable-next-line no-await-in-loop
          const activeProducts = await db.collection('products').countDocuments({ active: { $ne: false } });
          lines.push(`${db.databaseName}: licenses=${licenses}, products=${products}, activeProducts=${activeProducts}`);
        }
        await sendTelegramMessage(chatId, `Server stats:\n${lines.join('\n')}`);
        return;
      }

      await sendTelegramMessage(chatId, `Unknown command. Send /help`);
    } catch (error) {
      console.error('Telegram command error:', error);
      await sendTelegramMessage(chatId, `Command failed: ${error.message || 'Unknown error'}`);
    }
  };

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=0&offset=${offset}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = Math.max(offset, (update.update_id || 0) + 1);
          // eslint-disable-next-line no-await-in-loop
          await processUpdate(update);
        }
      }
    } catch (error) {
      console.error('Telegram bot polling error:', error);
    } finally {
      polling = false;
    }
  };

  await poll();
  setInterval(poll, 3000);
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

async function getServerConfigDoc(key) {
  const dbs = await getCandidateDbs();
  for (const db of dbs) {
    const doc = await db.collection('server_config').findOne({ key });
    if (doc) return { db, doc };
  }
  return { db: dbs[0] || await getPrimaryDb(), doc: null };
}

async function getExtensionSettings() {
  const env = getEnvExtensionSettings();
  const result = await getServerConfigDoc('extension_settings');
  const doc = result.doc || {};
  return {
    buyLicenseUrl: (doc.buyLicenseUrl || doc.whatsappLink || env.buyLicenseUrl || '').toString().trim(),
    expiryWarningDays: toInt(doc.expiryWarningDays, env.expiryWarningDays || 6),
  };
}

async function getExtensionUpdateConfig() {
  const env = getEnvUpdateConfig();
  const result = await getServerConfigDoc('extension_update');
  const doc = result.doc || {};
  return {
    enabled: toBool(doc.enabled, env.enabled),
    latestVersion: (doc.latestVersion || env.latestVersion || '').toString().trim(),
    updateUrl: (doc.updateUrl || env.updateUrl || '').toString().trim(),
    howToUpdate: (doc.howToUpdate || env.howToUpdate || '').toString().trim(),
    forceUpdate: toBool(doc.forceUpdate, env.forceUpdate),
    updatedAt: doc.updatedAt || null,
  };
}

function buildLicenseResponseExtras(license, expiresOn, settings) {
  return {
    expiresOn: expiresOn ? expiresOn.toISOString() : null,
    daysRemaining: expiresOn ? daysUntil(expiresOn) : null,
    hideAiToolsPromo: getLicensePromoHidden(license),
    showAiToolsInExpiryPopup: !getLicensePromoHidden(license),
    expiryWarningDays: toInt(settings?.expiryWarningDays, 6),
    buyLicenseUrl: settings?.buyLicenseUrl || '',
    licensePopup: {
      expiryWarningDays: toInt(settings?.expiryWarningDays, 6),
      buyLicenseUrl: settings?.buyLicenseUrl || '',
      hideAiToolsPromo: getLicensePromoHidden(license),
    },
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// --- Public extension update/settings endpoints ---
app.get('/api/extension/settings', async (req, res) => {
  try {
    const settings = await getExtensionSettings();
    return res.json(settings);
  } catch (error) {
    console.error('Extension settings error:', error);
    return res.status(500).json({ message: 'Failed to load extension settings' });
  }
});

app.get('/api/extension/update', async (req, res) => {
  try {
    const currentVersion = (req.query.version || req.query.currentVersion || '').toString().trim();
    const config = await getExtensionUpdateConfig();
    const updateAvailable = Boolean(
      config.enabled &&
      config.latestVersion &&
      currentVersion &&
      compareVersions(config.latestVersion, currentVersion) > 0
    );

    return res.json({
      updateAvailable,
      currentVersion: currentVersion || null,
      latestVersion: config.latestVersion || null,
      updateUrl: config.updateUrl || '',
      howToUpdate: config.howToUpdate || 'Download the new ZIP, open chrome://extensions, remove or disable the old version, extract the new ZIP, then Load unpacked the new folder.',
      forceUpdate: config.forceUpdate !== false,
      enabled: config.enabled,
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    console.error('Extension update check error:', error);
    return res.status(500).json({ message: 'Failed to check extension update' });
  }
});

// --- Admin extension update/settings endpoints ---
app.get('/api/admin/extension-update', requireAdmin, async (req, res) => {
  try {
    return res.json(await getExtensionUpdateConfig());
  } catch (error) {
    console.error('Read extension update config error:', error);
    return res.status(500).json({ message: 'Failed to read update config' });
  }
});

app.put('/api/admin/extension-update', requireAdmin, async (req, res) => {
  try {
    const current = await getServerConfigDoc('extension_update');
    const db = current.db || await getPrimaryDb();
    const doc = {
      key: 'extension_update',
      enabled: toBool(req.body.enabled, false),
      latestVersion: (req.body.latestVersion || '').toString().trim(),
      updateUrl: (req.body.updateUrl || '').toString().trim(),
      howToUpdate: (req.body.howToUpdate || '').toString().trim(),
      forceUpdate: toBool(req.body.forceUpdate, true),
      updatedAt: new Date(),
    };
    await db.collection('server_config').updateOne({ key: 'extension_update' }, { $set: doc }, { upsert: true });
    return res.json(doc);
  } catch (error) {
    console.error('Update extension update config error:', error);
    return res.status(500).json({ message: 'Failed to save update config' });
  }
});

app.get('/api/admin/extension-settings', requireAdmin, async (req, res) => {
  try {
    return res.json(await getExtensionSettings());
  } catch (error) {
    console.error('Read extension settings error:', error);
    return res.status(500).json({ message: 'Failed to read extension settings' });
  }
});

app.put('/api/admin/extension-settings', requireAdmin, async (req, res) => {
  try {
    const current = await getServerConfigDoc('extension_settings');
    const db = current.db || await getPrimaryDb();
    const doc = {
      key: 'extension_settings',
      buyLicenseUrl: (req.body.buyLicenseUrl || req.body.whatsappLink || '').toString().trim(),
      expiryWarningDays: toInt(req.body.expiryWarningDays, 6),
      updatedAt: new Date(),
    };
    await db.collection('server_config').updateOne({ key: 'extension_settings' }, { $set: doc }, { upsert: true });
    return res.json(doc);
  } catch (error) {
    console.error('Update extension settings error:', error);
    return res.status(500).json({ message: 'Failed to save extension settings' });
  }
});

// Hide/show AI Tools list in the expiry popup for exact license keys.
app.put('/api/admin/licenses/promo-visibility', requireAdmin, async (req, res) => {
  const licenseKey = readLicenseKey(req.body);
  if (!licenseKey) return res.status(400).json({ message: 'License key is required.' });

  try {
    const result = await findLicenseByKey(licenseKey);
    if (!result.license || !result.db) {
      return res.status(404).json({ message: 'License key not found.' });
    }
    const hideAiToolsPromo = toBool(req.body.hideAiToolsPromo, false);
    await result.db.collection('licenses').updateOne(
      { _id: result.license._id },
      {
        $set: {
          hideAiToolsPromo,
          showAiToolsInExpiryPopup: !hideAiToolsPromo,
          updated_at: new Date(),
        },
      }
    );
    return res.json({ licenseKey, hideAiToolsPromo, showAiToolsInExpiryPopup: !hideAiToolsPromo });
  } catch (error) {
    console.error('Update license promo visibility error:', error);
    return res.status(500).json({ message: 'Failed to update license promo visibility.' });
  }
});


// --- Admin license management helpers for dashboard/Telegram parity ---
app.post('/api/admin/licenses/generate', requireAdmin, async (req, res) => {
  try {
    const count = Math.max(1, Math.min(500, toInt(req.body.count, 1)));
    const days = Math.max(1, Math.min(3650, toInt(req.body.days || req.body.durationDays || req.body.duration_days, 30)));
    const hideAiToolsPromo = toBool(req.body.hideAiToolsPromo, false);
    const keys = await createLicenseKeys(count, days, { source: 'api', hideAiToolsPromo });
    return res.json({ count: keys.length, days, hideAiToolsPromo, keys });
  } catch (error) {
    console.error('Generate licenses error:', error);
    return res.status(500).json({ message: 'Failed to generate licenses.' });
  }
});

app.get('/api/admin/licenses/:licenseKey', requireAdmin, async (req, res) => {
  try {
    const key = normalizeLicenseKey(req.params.licenseKey);
    const result = await findLicenseByKey(key);
    if (!result.license) return res.status(404).json({ message: 'License not found.' });
    const expiresOn = buildExpiry(result.license.activated_on, result.license.duration_days);
    return res.json({
      ...result.license,
      expiresOn: expiresOn ? expiresOn.toISOString() : null,
      daysRemaining: expiresOn ? daysUntil(expiresOn) : null,
      hideAiToolsPromo: getLicensePromoHidden(result.license),
      showAiToolsInExpiryPopup: !getLicensePromoHidden(result.license),
    });
  } catch (error) {
    console.error('Read license error:', error);
    return res.status(500).json({ message: 'Failed to read license.' });
  }
});

app.delete('/api/admin/licenses/:licenseKey', requireAdmin, async (req, res) => {
  try {
    const key = normalizeLicenseKey(req.params.licenseKey);
    const result = await findLicenseByKey(key);
    if (!result.license || !result.db) return res.status(404).json({ message: 'License not found.' });
    await result.db.collection('licenses').deleteOne({ _id: result.license._id });
    return res.json({ success: true, licenseKey: key });
  } catch (error) {
    console.error('Delete license error:', error);
    return res.status(500).json({ message: 'Failed to delete license.' });
  }
});

app.put('/api/admin/licenses/:licenseKey/reset-device', requireAdmin, async (req, res) => {
  try {
    const key = normalizeLicenseKey(req.params.licenseKey);
    const result = await findLicenseByKey(key);
    if (!result.license || !result.db) return res.status(404).json({ message: 'License not found.' });
    await result.db.collection('licenses').updateOne(
      { _id: result.license._id },
      { $set: { device_id: null, updated_at: new Date() } }
    );
    return res.json({ success: true, licenseKey: key });
  } catch (error) {
    console.error('Reset license device error:', error);
    return res.status(500).json({ message: 'Failed to reset license device.' });
  }
});

app.put('/api/admin/licenses/:licenseKey/duration', requireAdmin, async (req, res) => {
  try {
    const key = normalizeLicenseKey(req.params.licenseKey);
    const days = Math.max(1, Math.min(3650, toInt(req.body.days || req.body.durationDays || req.body.duration_days, 30)));
    const result = await findLicenseByKey(key);
    if (!result.license || !result.db) return res.status(404).json({ message: 'License not found.' });
    await result.db.collection('licenses').updateOne(
      { _id: result.license._id },
      { $set: { duration_days: days, updated_at: new Date() } }
    );
    return res.json({ success: true, licenseKey: key, duration_days: days });
  } catch (error) {
    console.error('Set license duration error:', error);
    return res.status(500).json({ message: 'Failed to set license duration.' });
  }
});

app.put('/api/admin/licenses/:licenseKey/extend', requireAdmin, async (req, res) => {
  try {
    const key = normalizeLicenseKey(req.params.licenseKey);
    const addDays = Math.max(1, Math.min(3650, toInt(req.body.days || req.body.addDays, 1)));
    const result = await findLicenseByKey(key);
    if (!result.license || !result.db) return res.status(404).json({ message: 'License not found.' });
    const nextDays = toInt(result.license.duration_days, 0) + addDays;
    await result.db.collection('licenses').updateOne(
      { _id: result.license._id },
      { $set: { duration_days: nextDays, updated_at: new Date() } }
    );
    return res.json({ success: true, licenseKey: key, duration_days: nextDays, added_days: addDays });
  } catch (error) {
    console.error('Extend license error:', error);
    return res.status(500).json({ message: 'Failed to extend license.' });
  }
});

app.put('/api/admin/licenses/:licenseKey/flags', requireAdmin, async (req, res) => {
  try {
    const key = normalizeLicenseKey(req.params.licenseKey);
    const hideAiToolsPromo = toBool(req.body.hideAiToolsPromo, false);
    const updated = await updateLicensePromoFlag(key, hideAiToolsPromo);
    if (!updated) return res.status(404).json({ message: 'License not found.' });
    return res.json({ success: true, licenseKey: key, hideAiToolsPromo, showAiToolsInExpiryPopup: !hideAiToolsPromo });
  } catch (error) {
    console.error('Update license flags error:', error);
    return res.status(500).json({ message: 'Failed to update license flags.' });
  }
});

// Admin product aliases. Existing /api/products routes remain supported.
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const list = await listProductsAcrossDbs();
    return res.json({ products: list, count: list.length });
  } catch (error) {
    console.error('Admin products list error:', error);
    return res.status(500).json({ message: 'Failed to fetch products.' });
  }
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

    const settings = await getExtensionSettings();
    return res.status(200).json({
      message: 'License activated successfully!',
      licenseKey: license.key,
      ...buildLicenseResponseExtras(license, expiry, settings),
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

    const settings = await getExtensionSettings();
    return res.status(200).json({
      valid: true,
      licenseKey: license.key,
      ...buildLicenseResponseExtras(license, expiresOn, settings),
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
    const publicList = list.filter(p => p.active !== false);

    return res.json({
      products: publicList.map(p => ({
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
      count: publicList.length,
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

startTelegramBot().catch((error) => {
  console.error('Telegram bot start error:', error);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
