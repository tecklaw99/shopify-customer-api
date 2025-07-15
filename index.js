import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.json());

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

// --- FAST: Use Shopify's Search API for /find-by-phone ---
app.get('/find-by-phone', async (req, res) => {
  const last8 = req.query.last8;
  if (!last8 || !/^\d{8}$/.test(last8)) {
    return res.status(400).json({ error: 'Invalid last8' });
  }
  try {
    // Use Shopify's customer search endpoint (very fast!)
    const url = `https://${SHOPIFY_STORE}/admin/api/2024-07/customers/search.json?query=phone:*${last8}`;
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    const data = await response.json();
    if (data.customers && data.customers.length > 0) {
      const match = data.customers[0]; // Use the first match
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
  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
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
          last_name: lastName,
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
