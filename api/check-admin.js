import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const allowedOrigins = [
    'https://www.lazyweightloss.com',
    'https://lazyweightloss.com',
    'https://slimbloom.vercel.app',
  ];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

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
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  if ((user.email || '').toLowerCase() !== adminEmail) {
    return res.status(403).json({ error: 'Not authorized as admin' });
  }

  return res.status(200).json({ admin: true });
}
