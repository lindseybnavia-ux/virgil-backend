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

/**
 * Helper: Get an authenticated OAuth2 client for a given user.
 * Automatically refreshes expired tokens and updates Firestore.
 */
async function getAuthenticatedClient(userId) {
  const tokenDoc = await db.collection('google_tokens').doc(userId).get();

  if (!tokenDoc.exists) {
    throw new Error('NOT_CONNECTED');
  }

  const tokens = tokenDoc.data();

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date
  });

  // If token is expired or about to expire (within 5 min), refresh it
  const now = Date.now();
  if (tokens.expiry_date && now >= tokens.expiry_date - 300000) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Update stored tokens
      await db.collection('google_tokens').doc(userId).update({
        access_token: credentials.access_token,
        expiry_date: credentials.expiry_date
      });
    } catch (refreshError) {
      console.error('Token refresh failed:', refreshError);
      // If refresh fails, delete stale tokens so user can reconnect
      await db.collection('google_tokens').doc(userId).delete();
      throw new Error('TOKEN_EXPIRED');
    }
  }

  return oauth2Client;
}

/**
 * Build a Google Calendar event object from a Virgil action item.
 */
function buildCalendarEvent(todo, sessionType) {
  const priorityEmoji = {
    high: '🔴',
    medium: '🟡',
    low: '🟢'
  };

  const description = [
    todo.description,
    '',
    `Priority: ${priorityEmoji[todo.priority] || ''} ${todo.priority}`,
    sessionType ? `Session: ${sessionType}` : '',
    '',
    '— Created by Virgil'
  ].filter(Boolean).join('\n');

  return {
    summary: `✅ ${todo.title}`,
    description,
    start: {
      date: todo.dueDate  // All-day event (YYYY-MM-DD)
    },
    end: {
      date: todo.dueDate
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 * 9 } // Reminder at 9am on due date
      ]
    }
  };
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { userId, action } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  let oauth2Client;
  try {
    oauth2Client = await getAuthenticatedClient(userId);
  } catch (err) {
    if (err.message === 'NOT_CONNECTED' || err.message === 'TOKEN_EXPIRED') {
      return res.status(401).json({
        error: err.message,
        message: err.message === 'NOT_CONNECTED'
          ? 'Google Calendar is not connected. Please connect your account.'
          : 'Your Google Calendar connection has expired. Please reconnect.'
      });
    }
    throw err;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    // ─── CREATE: Add one or more action items to Google Calendar ───
    if (req.method === 'POST' && action === 'create') {
      const { todos, sessionType } = req.body;

      if (!todos || !Array.isArray(todos) || todos.length === 0) {
        return res.status(400).json({ error: 'No action items provided' });
      }

      const results = [];

      for (const todo of todos) {
        const event = buildCalendarEvent(todo, sessionType);

        const created = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: event
        });

        results.push({
          todoId: todo.id,
          googleEventId: created.data.id,
          htmlLink: created.data.htmlLink
        });
      }

      return res.status(200).json({
        success: true,
        message: `${results.length} event(s) added to Google Calendar`,
        events: results
      });
    }

    // ─── DELETE: Remove an event from Google Calendar ───
    if (req.method === 'POST' && action === 'delete') {
      const { googleEventId } = req.body;

      if (!googleEventId) {
        return res.status(400).json({ error: 'Missing googleEventId' });
      }

      await calendar.events.delete({
        calendarId: 'primary',
        eventId: googleEventId
      });

      return res.status(200).json({
        success: true,
        message: 'Event removed from Google Calendar'
      });
    }

    // ─── UPDATE: Update an existing event ───
    if (req.method === 'POST' && action === 'update') {
      const { todo, sessionType, googleEventId } = req.body;

      if (!googleEventId || !todo) {
        return res.status(400).json({ error: 'Missing googleEventId or todo data' });
      }

      const event = buildCalendarEvent(todo, sessionType);

      const updated = await calendar.events.update({
        calendarId: 'primary',
        eventId: googleEventId,
        requestBody: event
      });

      return res.status(200).json({
        success: true,
        googleEventId: updated.data.id,
        htmlLink: updated.data.htmlLink
      });
    }

    // ─── STATUS: Check connection status ───
    if (req.method === 'POST' && action === 'status') {
      // If we got here, the token is valid
      return res.status(200).json({
        connected: true,
        message: 'Google Calendar is connected'
      });
    }

    return res.status(400).json({ error: 'Invalid action. Use: create, delete, update, or status' });

  } catch (err) {
    console.error('Google Calendar API error:', err);

    if (err.code === 401 || err.code === 403) {
      // Token was revoked or permissions changed
      await db.collection('google_tokens').doc(userId).delete();
      return res.status(401).json({
        error: 'TOKEN_EXPIRED',
        message: 'Google Calendar access was revoked. Please reconnect.'
      });
    }

    return res.status(500).json({
      error: 'CALENDAR_ERROR',
      message: 'Failed to sync with Google Calendar. Please try again.'
    });
  }
};
