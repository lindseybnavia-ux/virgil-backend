const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const { google } = require('googleapis');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
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

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

console.log('API Key exists:', !!process.env.ANTHROPIC_API_KEY);
console.log('API Key length:', process.env.ANTHROPIC_API_KEY?.length);
console.log('Anthropic constructor:', typeof Anthropic);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

console.log('Anthropic client created:', !!anthropic);

app.get('/', (req, res) => {
  res.json({ status: 'Virgil Backend API is running' });
});

app.post('/api/generate-todos', async (req, res) => {
  try {
    const { sessionType, sessionDate, sessionNotes } = req.body;
    
    console.log('anthropic object:', anthropic);
    console.log('anthropic.messages:', anthropic.messages);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Based on this ${sessionType} session from ${sessionDate}, generate 3-5 specific, actionable to-do items that would help with personal growth and accountability.

Session notes:
${sessionNotes}

Return ONLY a JSON array of objects with this structure (no markdown, no preamble):
[
  {
    "title": "specific action item",
    "description": "why this matters and how to do it",
    "priority": "high|medium|low",
    "dueDate": "YYYY-MM-DD"
  }
]`
      }]
    });

    const responseText = message.content[0].text;
    const cleanedText = responseText.replace(/```json|```/g, '').trim();
    const todos = JSON.parse(cleanedText);

    res.json({ todos });
  } catch (error) {
    console.error('Error generating todos:', error);
    res.status(500).json({ error: 'Failed to generate action items' });
  }
});

app.post('/api/extract-text', async (req, res) => {
  try {
    const { image, mimeType } = req.body;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: image
            }
          },
          {
            type: 'text',
            text: 'Please extract and transcribe all text visible in this image. If there are handwritten notes, transcribe them as accurately as possible. Return only the transcribed text without any additional commentary.'
          }
        ]
      }]
    });

    const extractedText = message.content[0].text;
    res.json({ text: extractedText });
  } catch (error) {
    console.error('Error extracting text:', error);
    res.status(500).json({ error: 'Failed to extract text from image' });
  }
});

app.post('/api/generate-insights', async (req, res) => {
  try {
    const { sessions, previousInsight } = req.body;

    const sessionSummaries = sessions.map((s) => 
      `${s.type} session on ${s.date}:\n${s.notes}`
    ).join('\n\n---\n\n');

    let comparisonContext = '';
    if (previousInsight) {
      comparisonContext = `

PREVIOUS INSIGHTS (from ${previousInsight.sessionCount} sessions):
- Themes: ${previousInsight.themes.join(', ')}
- Key patterns identified: ${previousInsight.patterns.substring(0, 200)}...

Please note any CHANGES, PROGRESS, or NEW PATTERNS since the last report.`;
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Analyze these ${sessions.length} personal growth sessions and provide insights. When referencing specific sessions, use the session type (e.g., "In your Therapy Session on Jan 5..." or "Your Breathwork sessions show...") rather than session numbers. Return ONLY valid JSON with no markdown formatting:

${sessionSummaries}
${comparisonContext}

Return a JSON object with this exact structure:
{
  "themes": ["theme1", "theme2", "theme3"],
  "growthAreas": "A paragraph describing areas where growth is evident",
  "patterns": "A paragraph describing recurring patterns or emotional trends",
  "breakthroughs": "A paragraph highlighting key moments of clarity or insight",
  "recommendations": "A paragraph with specific, actionable next steps"${previousInsight ? ',\n  "progressSinceLast": "A paragraph comparing progress and changes since the last insights report"' : ''}
}`
      }]
    });

    const responseText = message.content[0].text;
    const cleanedText = responseText.replace(/```json|```/g, '').trim();
    const insights = JSON.parse(cleanedText);

    res.json({ insights });
  } catch (error) {
    console.error('Error generating insights:', error);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

// ─── Google Calendar: Start OAuth Flow ───
app.get('/api/google-auth', (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId parameter' });
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://virgil-backend-psi.vercel.app/api/google-callback'
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    prompt: 'consent',
    state: userId
  });

  res.redirect(authUrl);
});

// ─── Google Calendar: OAuth Callback ───
app.get('/api/google-callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

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
      'https://virgil-backend-psi.vercel.app/api/google-callback'
    );

    const { tokens } = await oauth2Client.getToken(code);

    await db.collection('google_tokens').doc(userId).set({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      token_type: tokens.token_type,
      scope: tokens.scope,
      connected_at: admin.firestore.FieldValue.serverTimestamp()
    });

    res.redirect('https://tryvirgil.co/?google_calendar=connected');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('https://tryvirgil.co/?google_calendar=error');
  }
});

// ─── Google Calendar: Create/Delete/Update Events & Status Check ───
app.post('/api/google-calendar', async (req, res) => {
  const { userId, action } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  // Get authenticated client
  let oauth2Client;
  try {
    const tokenDoc = await db.collection('google_tokens').doc(userId).get();

    if (!tokenDoc.exists) {
      return res.status(401).json({
        error: 'NOT_CONNECTED',
        message: 'Google Calendar is not connected. Please connect your account.'
      });
    }

    const tokens = tokenDoc.data();

    oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'https://virgil-backend-psi.vercel.app/api/google-callback'
    );

    oauth2Client.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date
    });

    // Refresh token if expired
    const now = Date.now();
    if (tokens.expiry_date && now >= tokens.expiry_date - 300000) {
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
        await db.collection('google_tokens').doc(userId).update({
          access_token: credentials.access_token,
          expiry_date: credentials.expiry_date
        });
      } catch (refreshError) {
        console.error('Token refresh failed:', refreshError);
        await db.collection('google_tokens').doc(userId).delete();
        return res.status(401).json({
          error: 'TOKEN_EXPIRED',
          message: 'Your Google Calendar connection has expired. Please reconnect.'
        });
      }
    }
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    // ── STATUS CHECK ──
    if (action === 'status') {
      return res.status(200).json({ connected: true, message: 'Google Calendar is connected' });
    }

    // ── CREATE EVENTS ──
    if (action === 'create') {
      const { todos, sessionType } = req.body;

      if (!todos || !Array.isArray(todos) || todos.length === 0) {
        return res.status(400).json({ error: 'No action items provided' });
      }

      const results = [];
      for (const todo of todos) {
        const event = {
          summary: `✅ ${todo.title}`,
          description: [
            todo.description,
            '',
            `Priority: ${{ high: '🔴', medium: '🟡', low: '🟢' }[todo.priority] || ''} ${todo.priority}`,
            sessionType ? `Session: ${sessionType}` : '',
            '',
            '— Created by Virgil'
          ].filter(Boolean).join('\n'),
          start: { date: todo.dueDate },
          end: { date: todo.dueDate },
          reminders: {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: 540 }]
          }
        };

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

    // ── DELETE EVENT ──
    if (action === 'delete') {
      const { googleEventId } = req.body;

      if (!googleEventId) {
        return res.status(400).json({ error: 'Missing googleEventId' });
      }

      await calendar.events.delete({
        calendarId: 'primary',
        eventId: googleEventId
      });

      return res.status(200).json({ success: true, message: 'Event removed from Google Calendar' });
    }

    // ── UPDATE EVENT ──
    if (action === 'update') {
      const { todo, sessionType, googleEventId } = req.body;

      if (!googleEventId || !todo) {
        return res.status(400).json({ error: 'Missing googleEventId or todo data' });
      }

      const event = {
        summary: `✅ ${todo.title}`,
        description: [
          todo.description,
          '',
          `Priority: ${{ high: '🔴', medium: '🟡', low: '🟢' }[todo.priority] || ''} ${todo.priority}`,
          sessionType ? `Session: ${sessionType}` : '',
          '',
          '— Created by Virgil'
        ].filter(Boolean).join('\n'),
        start: { date: todo.dueDate },
        end: { date: todo.dueDate }
      };

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

    return res.status(400).json({ error: 'Invalid action. Use: create, delete, update, or status' });

  } catch (err) {
    console.error('Google Calendar API error:', err);

    if (err.code === 401 || err.code === 403) {
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
});

module.exports = app;
