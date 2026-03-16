// index.js
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import cors from 'cors';
import crypto from 'crypto';
import { URLSearchParams } from 'node:url';

const app = express();
const PORT = process.env.PORT || 3000;

// ① Your live HitPay API
const HITPAY_BASE_URL = 'https://api.hit-pay.com/v1';

// ② Env vars you must set in Railway
const {
  SHOPIFY_STORE,
  ACCESS_TOKEN,
  HITPAY_API_KEY,
  HITPAY_WEBHOOK_SALT,
} = process.env;

// ③ Fail fast if any required var is missing
if (!SHOPIFY_STORE || !ACCESS_TOKEN || !HITPAY_API_KEY || !HITPAY_WEBHOOK_SALT) {
  console.error('⚠️ Missing one of SHOPIFY_STORE, ACCESS_TOKEN, HITPAY_API_KEY, HITPAY_WEBHOOK_SALT');
  process.exit(1);
}

// ④ Global middleware
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false, verify: (req, _res, buf) => (req.rawBody = buf) }));

// ⑤ Startup log
console.log(`🟢 Server starting with routes:`);
app._router && console.log(app._router.stack.map(r => r.route && r.route.path));

// ⑥ Health check
app.get('/', (_req, res) => res.send('OK'));

// ⑦ Debug ping
app.post('/ping', (req, res) => {
  console.log('🔥 Received POST /ping:', req.body);
  res.json({ ok: true, received: req.body });
});

// ⑧ Shopify: fetch all customers
async function fetchAllCustomers() {
  let all = [];
  let nextUrl = `https://${SHOPIFY_STORE}/admin/api/2025-07/customers.json?limit=250`;
  while (nextUrl) {
    const resp = await fetch(nextUrl, {
      headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' },
    });
    const { customers } = await resp.json();
    all = all.concat(customers || []);
    const link = resp.headers.get('link');
    nextUrl = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  return all;
}

// ⑨ Shopify: find-by-phone
app.get('/find-by-phone', async (req, res) => {
  const { last8 } = req.query;
  if (!/^[0-9]{8}$/.test(last8)) {
    return res.status(400).json({ error: 'Invalid phone query' });
  }

  try {
    // Use the Shopify search endpoint—no pagination, much faster
    const url = `https://${SHOPIFY_STORE}/admin/api/2025-07/customers/search.json?` +
                `query=phone:*${encodeURIComponent(last8)}`;
    console.log('Searching customers via:', url);
    
    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN }
    });
    console.log('Shopify status:', resp.status);
    
    if (!resp.ok) {
      const err = await resp.text();
      console.error('Search error body:', err);
      return res.status(resp.status).json({ error: 'Shopify search failed' });
    }

    const { customers } = await resp.json();
    // Find the best match just in case there are multiple
    const cust = customers.find(c => 
      c.phone?.replace(/\D/g, '').endsWith(last8)
    );
    if (!cust) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({
      id: cust.id,
      displayName: [cust.first_name, cust.last_name].filter(Boolean).join(' '),
      email: cust.email,
      phone: cust.phone,
    });
  } catch (e) {
    console.error('📞 find-by-phone exception', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ⑨½ Shopify: find-by-email
app.get('/find-by-email', async (req, res) => {
  const { email } = req.query;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email query' });
  }

  try {
    // Use Shopify’s search endpoint so you don’t have to page through everyone
    const url = `https://${SHOPIFY_STORE}/admin/api/2025-07/customers/search.json?query=email:${encodeURIComponent(email)}`;
    const resp = await fetch(url, {
      headers: { 
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error('Shopify search error:', body);
      return res.status(resp.status).json({ error: 'Shopify search failed' });
    }
    const { customers } = await resp.json();
    // Pick the exact-match customer
    const cust = customers.find(c => c.email === email);
    if (!cust) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.json({
      id: cust.id,
      displayName: [cust.first_name, cust.last_name].filter(Boolean).join(' '),
      email: cust.email,
      phone: cust.phone,
    });
  } catch (e) {
    console.error('📧 find-by-email error', e);
    res.status(500).json({ error: e.message || 'Internal' });
  }
});


// ⑩ Shopify: create-customer
app.post('/create-customer', async (req, res) => {
  const { firstName, lastName, email, phone } = req.body;
  if (!firstName || !lastName || !email || !phone) 
    return res.status(400).json({ error: 'Missing required fields' });

  const defaultpassword = "abc123456"; // 👈 default password

  try {
    const resp = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-07/customers.json`, {
      method: 'POST',
      headers: { 
        'X-Shopify-Access-Token': ACCESS_TOKEN, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ 
        customer: { 
          first_name: firstName, 
          last_name: lastName, 
          email, 
          phone,
          password:defaultpassword,
          password_confirmation: defaultpassword,             // 👈 insert default password
          send_email_invite: false // optional: prevents Shopify sending email
        } 
      }),
    });

    const data = await resp.json();
    if (data.errors) return res.status(400).json({ error: 'Shopify error', detail: data.errors });
    res.json({ customerId: data.customer.id });
  } catch (e) {
    console.error(' create-customer error', e);
    res.status(500).json({ error: e.message || 'Unknown' });
  }
});

// ⑪ Shopify: check-order
app.post('/check-order', async (req, res) => {
  const { customerId, since, amount } = req.body;
  if (!customerId || !since || amount == null) return res.status(400).json({ error: 'Missing params' });
  try {
    const params = new URLSearchParams({ status: 'any', customer_id: String(customerId), created_at_min: since, limit: '250' });
    const resp = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-07/orders.json?${params}`, {
      headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' },
    });
    const { orders } = await resp.json();
    const found = orders.some(o => parseFloat(o.total_price) === Number(amount));
    res.json({ orderFound: found });
  } catch (e) {
    console.error('📦 check-order error', e);
    res.status(500).json({ error: 'Failed to check order' });
  }
});

// ⑫ HitPay: create payment request
app.post('/hitpay/create', async (req, res) => {
  console.log('🔥 Received POST /hitpay/create:', req.body);
  const { amount, email, webhook } = req.body;
  const parsed = Number(amount);
  if (!parsed || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const params = new URLSearchParams();
  params.append('amount', parsed.toFixed(2)); // HitPay expects 2 decimal places
  params.append('currency', 'SGD');
  params.append('payment_methods[]', 'paynow_online');
  params.append('generate_qr', 'true'); // 🔥 make sure it's set
  params.append('reference_number', `POS-${Date.now()}`);
  params.append('redirect_url', webhook || `https://shopify-customer-api-production.up.railway.app/hitpay/webhook`);
  if (email) params.append('email', email);

  try {
    const resp = await fetch(`${HITPAY_BASE_URL}/payment-requests`, {
      method: 'POST',
      headers: {
        'X-BUSINESS-API-KEY': HITPAY_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: params.toString(),
    });

    const data = await resp.json();
    console.log('⬅️ HitPay response:', data);

    // 1️⃣ Check if HitPay gave us a direct QR image URL
    let qrCodeUrl = data.qr_code_data?.qr_code;

    // 2️⃣ If it's actually raw QR string (starts with "000201"), convert it to QR image
    if (qrCodeUrl && qrCodeUrl.startsWith('000201')) {
      qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrCodeUrl)}`;
      console.log('🔁 Converted raw QR string to image URL:', qrCodeUrl);
    }

    if (!resp.ok || !qrCodeUrl) {
      return res.status(resp.status).json({
        error: 'HitPay create failed',
        detail: data,
      });
    }

    return res.json({
      paymentRequestId: data.id,
      qrCodeUrl, // ✅ now always a proper image URL
      checkoutUrl: data.url,
    });
  } catch (err) {
    console.error('🔥 HitPay create exception:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ⑬ HitPay: status
app.get('/hitpay/status', async (req, res) => {
  console.log('🔥 Received GET /hitpay/status:', req.query);
  const { paymentRequestId } = req.query;
  if (!paymentRequestId) return res.status(400).json({ error: 'Missing paymentRequestId' });
  try {
    const resp = await fetch(`${HITPAY_BASE_URL}/payment-requests/${paymentRequestId}`, { headers: { 'X-BUSINESS-API-KEY': HITPAY_API_KEY } });
    const data = await resp.json();
    console.log('⬅️ Status response:', data);
    return res.json({ success: data.status === 'completed' });
  } catch (err) {
    console.error('🔥 HitPay status exception:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ⑭ HitPay: webhook
app.post('/hitpay/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const sigHeader = req.get('x-hitpay-signature') || '';
  const rawBody = req.body;

  const expected = crypto
    .createHmac('sha256', HITPAY_WEBHOOK_SALT)
    .update(rawBody)
    .digest('hex');

  if (expected !== sigHeader) {
    console.warn('🚨 Invalid webhook signature', {
      expected: expected.slice(0, 16),
      received: sigHeader.slice(0, 16),
    });
    return res.status(401).send('Invalid signature');
  }

  const data = JSON.parse(rawBody.toString('utf8'));
  console.log('✅ Valid webhook payload:', data);

  res.sendStatus(200);
});

// In-memory session heartbeats
const lastSeen = new Map(); // ← FIX HERE

app.post('/heartbeat', (req, res) => {
  const { sessionId } = req.body;
  if (typeof sessionId !== 'string') return res.status(400).json({ error: 'sessionId is required' });
  lastSeen.set(sessionId, Date.now());
  res.json({ ok: true });
});

app.get('/check', (req, res) => {
  const sessionId = req.query.sessionId;
  if (typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId query parameter is required' });
  }

  if (!lastSeen.has(sessionId)) {
    // no heartbeat seen yet (or we cleared it after the last trigger)
    return res.json({ trigger: false });
  }

  const last = lastSeen.get(sessionId);
  const timedOut = (Date.now() - last) > 3500;

  if (timedOut) {
    // fire trigger once, then clear so it won't re-trigger until another heartbeat
    lastSeen.delete(sessionId);
    return res.json({ trigger: true });
  }
  return res.json({ trigger: false });
});


// 1. Eligibility: check customer tag "gb02"
app.post('/eligibility/first-time', async (req, res) => {
const { customerId } = req.body;
if (typeof customerId !== 'number') {
return res.status(400).json({ error: 'customerId must be a number' });
}
try {
// Fetch the customer record
const url = `https://${SHOPIFY_STORE}/admin/api/2025-07/customers/${customerId}.json`;
const resp = await fetch(url, {
headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' }
});
if (!resp.ok) throw await resp.text();
const { customer } = await resp.json();
// Check if the tag "gb02" is present
const tags = customer.tags ? customer.tags.split(',').map(t => t.trim().toLowerCase()) : [];
const hasTag = tags.includes('gb02');


// eligible only if the tag is NOT present
return res.json({ eligible: !hasTag, tags: customer.tags });
} catch (err) {
console.error('Eligibility error', err);
return res.status(500).json({ error: 'Internal server error' });
}
});

app.post('/eligibility/check-tag', async (req, res) => {
  const { customerId, tag } = req.body;

  if (typeof customerId !== 'number') {
    return res.status(400).json({ error: 'customerId must be a number' });
  }

  if (!tag || typeof tag !== 'string') {
    return res.status(400).json({ error: 'tag is required' });
  }

  try {
    const url = `https://${SHOPIFY_STORE}/admin/api/2025-07/customers/${customerId}.json`;

    const resp = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      throw new Error(await resp.text());
    }

    const { customer } = await resp.json();

    const tags = customer.tags
      ? customer.tags.split(',').map((t) => t.trim().toLowerCase())
      : [];

    const purchaseTag = tag.trim().toLowerCase();
    const redeemedTag = `redeemed-${purchaseTag}`;

    const hasRedeemedTag = tags.includes(redeemedTag);
    const hasPurchaseTag = tags.includes(purchaseTag);

    // 1) 已领取过
    if (hasRedeemedTag) {
      return res.json({
        eligible: false,
        reason: 'already_redeemed',
      });
    }

    // 2) 已下单，可以领取
    if (hasPurchaseTag) {
      return res.json({
        eligible: true,
        reason: 'purchased_can_redeem',
      });
    }

    // 3) 两个都没有，还没下单
    return res.json({
      eligible: false,
      reason: 'not_purchased_yet',
    });
  } catch (err) {
    console.error('eligibility/check-tag error:', err);

    return res.status(500).json({
      error: 'shopify_api_error',
      message: String(err.message || err),
    });
  }
});


// ⑮ Start server
app.listen(PORT, () => console.log(`🟩 Server listening on port ${PORT}`));
