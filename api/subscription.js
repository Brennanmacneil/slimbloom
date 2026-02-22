import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Extract JWT from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.replace('Bearer ', '');

  // 2. Initialize Supabase with service role key
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 3. Verify the user via their JWT
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // 4. Query membership by user_id
  const { data: memberships, error: dbError } = await supabase
    .from('memberships')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (dbError) {
    console.error('DB error:', dbError);
    return res.status(500).json({ error: 'Database error' });
  }

  // 5. If found, return it
  if (memberships && memberships.length > 0) {
    return res.status(200).json({ subscription: memberships[0] });
  }

  // 6. Lazy linking: try matching by email where user_id is null
  if (user.email) {
    const { data: emailMemberships } = await supabase
      .from('memberships')
      .select('*')
      .eq('whop_user_email', user.email.toLowerCase())
      .is('user_id', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (emailMemberships && emailMemberships.length > 0) {
      // Link the membership to this Supabase user
      const { error: linkError } = await supabase
        .from('memberships')
        .update({ user_id: user.id })
        .eq('id', emailMemberships[0].id);

      if (linkError) {
        console.error('Failed to link membership:', linkError);
      } else {
        console.log(`Lazy-linked membership ${emailMemberships[0].whop_membership_id} to user ${user.id}`);
      }

      // Return the membership (with user_id now set)
      emailMemberships[0].user_id = user.id;
      return res.status(200).json({ subscription: emailMemberships[0] });
    }
  }

  // 7. No subscription found
  return res.status(200).json({ subscription: null });
}
