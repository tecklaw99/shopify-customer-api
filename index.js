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
const HITPAY_BASE_URL = 'https://api.hit-payapp.com/v1';

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
  if (!firstName || !lastName || !email || !phone) return res.status(400).json({ error: 'Missing required fields' });
  try {
    const resp = await fetch(`https://${SHOPIFY_STORE}/admin/api/2025-07/customers.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: { first_name: firstName, last_name: lastName, email, phone } }),
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
  params.append('amount', Math.round(parsed * 100).toString());
  params.append('currency', 'SGD');
  params.append('payment_methods[]', 'paynow_online');
  params.append('generate_qr', 'true');
  params.append('reference_number', `POS-${Date.now()}`);
  params.append('redirect_url', webhook || `https://shopify-customer-api-production.up.railway.app/hitpay/webhook`);
  if (email) params.append('email', email);

  try {
    const resp = await fetch(`${HITPAY_BASE_URL}/payment-requests`, {
      method: 'POST',
      headers: { 'X-BUSINESS-API-KEY': HITPAY_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: params.toString(),
    });
    const data = await resp.json();
    console.log('⬅️ HitPay response:', data);
    if (!resp.ok || !data.qr_code_data?.qr_code) {
      return res.status(resp.status).json({ error: 'HitPay create failed', detail: data });
    }
    return res.json({ paymentRequestId: data.id, qrCodeUrl: data.qr_code_data.qr_code, checkoutUrl: data.url });
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
app.post('/hitpay/webhook', express.urlencoded({ extended: false }), (req, res) => {
  console.log('🔥 Received POST /hitpay/webhook:', req.body);
  const { hmac, ...fields } = req.body;
  const sorted = Object.keys(fields).sort().map(k => k + fields[k]).join('');
  const digest = crypto.createHmac('sha256', HITPAY_WEBHOOK_SALT).update(sorted).digest('hex');
  if (digest !== hmac) {
    console.warn('🚨 Webhook signature mismatch', { expected: digest, received: hmac });
    return res.status(403).send('Invalid signature');
  }
  console.log('✅ Valid webhook payload:', fields);
  res.sendStatus(200);
});

// In-memory session heartbeats
const lastSeen = new Map();
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

  // still within heartbeat window
  res.json({ trigger: false });
});


// ⑮ Start server
app.listen(PORT, () => console.log(`🟩 Server listening on port ${PORT}`));
