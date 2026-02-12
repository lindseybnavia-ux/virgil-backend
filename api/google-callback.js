const { google } = require('googleapis');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK (reuse across invocations)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state: userId, error } = req.query;

  // User denied access
  if (error) {
    return res.redirect('https://tryvirgil.co/?google_calendar=denied');
  }

  if (!code || !userId) {
    return res.status(400).json({ error: 'Missing code or userId' });
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    // Store tokens in Firestore, keyed by userId
    await db.collection('google_tokens').doc(userId).set({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      token_type: tokens.token_type,
      scope: tokens.scope,
      connected_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // Redirect back to the FRONTEND app with success indicator
    res.redirect('https://tryvirgil.co/?google_calendar=connected');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('https://tryvirgil.co/?google_calendar=error');
  }
};
