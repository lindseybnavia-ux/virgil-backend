const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

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

module.exports = app;
