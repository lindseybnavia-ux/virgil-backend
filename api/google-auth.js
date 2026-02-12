const { google } = require('googleapis');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://virgil-backend-theta.vercel.app/api/google-callback'
  );

  // Pass the Firebase userId through state so we can associate tokens after callback
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId parameter' });
  }

  const scopes = ['https://www.googleapis.com/auth/calendar.events'];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',       // Gets refresh_token for long-lived access
    scope: scopes,
    prompt: 'consent',            // Forces consent screen so we always get refresh_token
    state: userId                 // Pass userId through OAuth flow
  });

  res.redirect(authUrl);
};
