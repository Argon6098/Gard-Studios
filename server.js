const express = require('express');
const session = require('express-session');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admZip = require('adm-zip');
const ExcelJS = require('exceljs');
const admin = require('firebase-admin');
const { cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// Session Security for Admin Access
app.use(session({
  secret: process.env.SESSION_SECRET || 'gard-studios-session-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 } // 1 Hour
}));

// 1. Firebase Admin Initializer
// Ensure serviceAccountKey.json exists locally OR pass raw credentials via process.env
if (fs.existsSync(path.join(__dirname, 'serviceAccountKey.json'))) {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://gard-studios-default-rtdb.firebaseio.com"
  });
} else if (process.env.FIREBASE_CONFIG_JSON) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
  admin.initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://gard-studios-default-rtdb.firebaseio.com"
  });
} else {
  admin.initializeApp({
    databaseURL: "https://gard-studios-default-rtdb.firebaseio.com"
  });
}

const db = getDatabase();

// 2. Stripe Key Configuration
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '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';
const stripe = require('stripe')(STRIPE_SECRET_KEY);

// 3. Static Assets & Web Routes
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 4. Admin Auth API Endpoints
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'GardStudios2026!';

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  } else {
    return res.status(401).json({ success: false, error: 'Invalid admin username or password.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Admin Protection Middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.status(403).json({ error: 'Unauthorized administrative action.' });
}

// 5. Stripe Checkout Session APIs
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { userId, amount, projectType } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Deposit: ${projectType || 'Gard Studios Project'}` },
          unit_amount: Math.round((amount || 337.50) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/?payment=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/?payment=cancel`,
      client_reference_id: userId
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/create-final-checkout-session', async (req, res) => {
  try {
    const { userId, amount, projectType } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Final Balance Settlement: ${projectType || 'Gard Studios Project'}` },
          unit_amount: Math.round((amount || 337.50) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/?final_payment=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/?final_payment=cancel`,
      client_reference_id: userId
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Admin Project Management & Excel Export APIs
app.post('/api/admin/deploy-preview/:uid', requireAdmin, async (req, res) => {
  try {
    const uid = req.params.uid;
    if (!req.files || !req.files.projectZip) {
      return res.status(400).json({ success: false, error: 'No .ZIP build uploaded.' });
    }

    const zipFile = req.files.projectZip;
    const targetDir = path.join(__dirname, 'public', 'previews', uid);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const zip = new admZip(zipFile.data);
    zip.extractAllTo(targetDir, true);

    const previewUrl = `/previews/${uid}/index.html`;
    await db.ref(`projects/${uid}`).update({ previewUrl, stage: 3 });

    res.json({ success: true, previewUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/delete-project/:uid', requireAdmin, async (req, res) => {
  try {
    const uid = req.params.uid;
    await db.ref(`projects/${uid}`).remove();
    await db.ref(`users/${uid}`).remove();

    const previewFolder = path.join(__dirname, 'public', 'previews', uid);
    if (fs.existsSync(previewFolder)) {
      fs.rmSync(previewFolder, { recursive: true, force: true });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/export-sales', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.ref('projects').once('value');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Gard Studios Sales Ledger');

    worksheet.columns = [
      { header: 'Client UID', key: 'uid', width: 30 },
      { header: 'Client Name', key: 'name', width: 25 },
      { header: 'Company', key: 'company', width: 25 },
      { header: 'Project Category', key: 'type', width: 25 },
      { header: 'Deposit Amount ($)', key: 'deposit', width: 20 },
      { header: 'Approval Status', key: 'status', width: 15 },
      { header: 'Current Stage', key: 'stage', width: 15 },
      { header: 'Final Settlement', key: 'finalPaid', width: 20 }
    ];

    if (snapshot.exists()) {
      const projects = snapshot.val();
      for (const uid of Object.keys(projects)) {
        const p = projects[uid];
        worksheet.addRow({
          uid: uid,
          name: p.clientName || 'N/A',
          company: p.clientCompany || 'N/A',
          type: p.projectType || 'Standard',
          deposit: p.depositAmount || 0,
          status: p.approvalStatus || 'None',
          stage: p.stage || 1,
          finalPaid: p.finalPaid ? 'Paid in Full' : 'Pending Balance'
        });
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Gard_Studios_Sales_Ledger.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).send('Failed to generate sales ledger export.');
  }
});

// 7. Single Server Listen Execution
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gard Studios Server active on port ${PORT}`);
});