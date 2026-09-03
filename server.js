const express = require('express');
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

// 1. Serve static assets
app.use(express.static(path.join(__dirname, 'public')));

// 2. Client Portal Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 3. Admin Dashboard Route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Firebase / Stripe initialization and API routes follow...

// Initialize Stripe with Secret Live Key
const stripe = require('stripe')('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');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Initialize Firebase Admin SDK
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

if (fs.existsSync(serviceAccountPath)) {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://gard-studios-default-rtdb.firebaseio.com"
  });
  console.log('Firebase Admin SDK initialized successfully.');
} else {
  console.warn('WARNING: serviceAccountKey.json not found in root folder!');
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// Serve static frontend files from /public folder
app.use(express.static(path.join(__dirname, 'public')));

// Explicit Static Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 1. STRIPE ROUTE: Create Deposit Checkout Session (Stage 1 -> Stage 2)
app.post('/api/create-checkout-session', async (req, res) => {
  const { userId, amount, projectType } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Gard Studios - Initial Deposit (${projectType || 'Custom Project'})`,
              description: 'Initial deposit to begin Stage 2 creation phase.',
            },
            unit_amount: Math.round((amount || 337.50) * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `http://localhost:3000/?payment=success&uid=${userId}`,
      cancel_url: `http://localhost:3000/?payment=cancel`,
    });

    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe Deposit Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. STRIPE ROUTE: Create Final Balance Checkout Session (Stage 4 Handover)
app.post('/api/create-final-checkout-session', async (req, res) => {
  const { userId, amount, projectType } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Gard Studios - Final Balance (${projectType || 'Custom Project'})`,
              description: 'Final 50% payment to unlock complete source bundle download.',
            },
            unit_amount: Math.round((amount || 337.50) * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `http://localhost:3000/?final_payment=success&uid=${userId}`,
      cancel_url: `http://localhost:3000/?payment=cancel`,
    });

    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe Final Payment Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. ADMIN ROUTE: Deploy Preview (Stage 3)
app.post('/api/admin/deploy-preview/:projectId', async (req, res) => {
  const { projectId } = req.params;

  if (!req.files || !req.files.projectZip) {
    return res.status(400).json({ error: 'No project files uploaded.' });
  }

  const zipFile = req.files.projectZip;
  const previewToken = crypto.randomBytes(8).toString('hex');
  const expiresAt = Date.now() + (2 * 60 * 60 * 1000); // 2 Hours
  const extractPath = path.join(__dirname, 'public', 'previews', previewToken);

  fs.mkdirSync(extractPath, { recursive: true });
  const tempZipPath = path.join(extractPath, 'temp.zip');

  zipFile.mv(tempZipPath, async (err) => {
    if (err) return res.status(500).json({ error: 'Failed to save upload.' });

    try {
      const zip = new admZip(tempZipPath);
      zip.extractAllTo(extractPath, true);
      fs.unlinkSync(tempZipPath);

      let relativePath = `/previews/${previewToken}/index.html`;

      if (!fs.existsSync(path.join(extractPath, 'index.html'))) {
        const files = fs.readdirSync(extractPath);
        const nestedDir = files.find(file => fs.statSync(path.join(extractPath, file)).isDirectory());

        if (nestedDir && fs.existsSync(path.join(extractPath, nestedDir, 'index.html'))) {
          relativePath = `/previews/${previewToken}/${nestedDir}/index.html`;
        }
      }

      const db = getDatabase();
      await db.ref(`projects/${projectId}`).update({
        stage: 3,
        previewToken: previewToken,
        previewExpiresAt: expiresAt,
        previewUrl: relativePath
      });

      await db.ref(`projects/${projectId}/messages`).push({
        sender: 'Gard Studios Admin',
        text: 'Welcome to Stage 3! Your live preview is ready.',
        timestamp: Date.now()
      });

      res.json({
        success: true,
        stage: 3,
        previewUrl: relativePath,
        expiresAt: expiresAt
      });
    } catch (extractErr) {
      console.error('Extraction Error:', extractErr);
      res.status(500).json({ error: 'Failed to extract ZIP archive: ' + extractErr.message });
    }
  });
});

// 4. ADMIN ROUTE: Delete Project & Cleanup Files
app.delete('/api/admin/delete-project/:projectId', async (req, res) => {
  const { projectId } = req.params;

  try {
    const db = getDatabase();
    
    const snapshot = await db.ref(`projects/${projectId}`).once('value');
    if (snapshot.exists()) {
      const data = snapshot.val();
      if (data.previewToken) {
        const previewFolderPath = path.join(__dirname, 'public', 'previews', data.previewToken);
        if (fs.existsSync(previewFolderPath)) {
          fs.rmSync(previewFolderPath, { recursive: true, force: true });
        }
      }
    }

    await db.ref(`projects/${projectId}`).remove();
    res.json({ success: true, message: 'Project deleted successfully.' });
  } catch (err) {
    console.error('Delete Project Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. FINANCIALS ROUTE: Generate & Download Sales Excel Ledger (.xlsx)
app.get('/api/admin/export-sales', async (req, res) => {
  try {
    const db = getDatabase();
    const snapshot = await db.ref('projects').once('value');

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Gard Studios Sales Ledger');

    worksheet.columns = [
      { header: 'Client Email', key: 'email', width: 30 },
      { header: 'Project Category', key: 'projectType', width: 25 },
      { header: 'Approval Status', key: 'status', width: 15 },
      { header: 'Deposit Price ($)', key: 'deposit', width: 18 },
      { header: 'Total Value ($)', key: 'total', width: 18 },
      { header: 'Final Paid Status', key: 'finalPaid', width: 18 },
      { header: 'Signee Legal Name', key: 'signee', width: 25 },
      { header: 'Completion Date', key: 'date', width: 22 }
    ];

    if (snapshot.exists()) {
      const projects = snapshot.val();
      Object.keys(projects).forEach(uid => {
        const proj = projects[uid];
        const deposit = proj.depositAmount || 0;
        const total = deposit * 2;

        worksheet.addRow({
          email: proj.email || uid,
          projectType: proj.projectType || 'Custom Project',
          status: proj.approvalStatus || 'pending',
          deposit: deposit.toFixed(2),
          total: total.toFixed(2),
          finalPaid: (proj.finalPaid || deposit === 0) ? 'PAID IN FULL' : 'PENDING BALANCE',
          signee: proj.signedAgreement ? proj.signedAgreement.fullName : 'N/A',
          date: proj.completedAt ? new Date(proj.completedAt).toLocaleDateString() : (proj.stage === 4 ? 'Completed' : 'In Progress')
        });
      });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Gard_Studios_Tax_Sales_Ledger.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel Export Error:', err);
    res.status(500).json({ error: 'Failed to generate Excel ledger: ' + err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Gard Studios Server running at http://localhost:${PORT}`);
});