import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

async function fetchAllCustomers() {
  let all = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/2024-07/customers.json?limit=250`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    all = all.concat(data.customers || []);
    const link = res.headers.get('link');
    url = null;
    if (link && link.includes('rel="next"')) {
      url = link.match(/<([^>]+)>; rel="next"/)[1];
    }
  }
  return all;
}

app.get('/find-by-phone', async (req, res) => {
  const last8 = req.query.last8;
  if (!last8 || !/^\d{8}$/.test(last8)) {
    return res.status(400).json({ error: 'Invalid last8' });
  }
  try {
    const customers = await fetchAllCustomers();
    const match = customers.find(c => {
      if (!c.phone) return false;
      const digits = c.phone.replace(/\D/g, '');
      return digits.slice(-8) === last8;
    });
    if (match) {
      res.json({
        id: match.id,
        displayName: (match.first_name || '') + ' ' + (match.last_name || ''),
        email: match.email,
        phone: match.phone,
      });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message || 'Internal error' });
  }
});

app.post('/create-customer', async (req, res) => {
  const { firstName, lastName, email, phone } = req.body;
  if (!firstName || !email || !phone) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const safeLastName = typeof lastName === 'string' ? lastName : '';
  try {
    const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-07/customers.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: {
          first_name: firstName,
          last_name: safeLastName,
          email,
          phone,
        }
      })
    });
    const data = await response.json();
    if (data.errors || data.error) {
      return res.status(400).json({ error: data.errors || data.error });
    }
    return res.json({ customerId: data.customer.id });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to create customer' });
  }
});

app.get('/', (req, res) => res.send('Shopify Customer API running.'));

app.listen(PORT, () => console.log('Server running on port', PORT));
