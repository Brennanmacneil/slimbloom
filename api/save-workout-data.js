import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: verify JWT
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Admin check: only allow the designated admin email
  const adminEmail = process.env.ADMIN_EMAIL || '';
  if (user.email.toLowerCase() !== adminEmail.toLowerCase()) {
    return res.status(403).json({ error: 'Not authorized as admin' });
  }

  // Parse body
  const payload = req.body;
  if (!payload || (!payload.schedule && !payload.library && !payload.exerciseDb)) {
    return res.status(400).json({ error: 'No data provided' });
  }

  const GH_TOKEN = process.env.GITHUB_TOKEN;
  if (!GH_TOKEN) {
    return res.status(500).json({ error: 'GitHub token not configured on server' });
  }

  const GH_OWNER = 'Brennanmacneil';
  const GH_REPO = 'slimbloom';
  const GH_FILE = 'workout-data.json';
  const GH_BRANCH = 'main';

  try {
    // Step 1: Get current file SHA
    const getRes = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}?ref=${GH_BRANCH}`,
      {
        headers: {
          Authorization: `token ${GH_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    let sha = null;
    if (getRes.ok) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    }

    // Step 2: Encode content as base64
    const jsonContent = JSON.stringify(payload, null, 2);
    const base64Content = Buffer.from(jsonContent, 'utf8').toString('base64');

    // Step 3: PUT to GitHub API
    const putBody = {
      message: 'Update workout data via admin panel',
      content: base64Content,
      branch: GH_BRANCH,
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${GH_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify(putBody),
      }
    );

    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error('GitHub API error:', errText);
      return res.status(502).json({ error: 'Failed to save to GitHub' });
    }

    return res.status(200).json({ success: true, message: 'Saved successfully' });
  } catch (err) {
    console.error('Save error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
