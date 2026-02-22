import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
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

  // 4. Get user's active membership
  const { data: memberships } = await supabase
    .from('memberships')
    .select('*')
    .eq('user_id', user.id)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (!memberships || memberships.length === 0) {
    return res.status(404).json({ error: 'No active subscription found' });
  }

  const membership = memberships[0];

  // 5. Call Whop cancel endpoint
  try {
    const whopRes = await fetch(
      `https://api.whop.com/api/v1/memberships/${membership.whop_membership_id}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cancellation_mode: 'at_period_end',
        }),
      }
    );

    if (!whopRes.ok) {
      const errBody = await whopRes.text();
      console.error('Whop cancel error:', whopRes.status, errBody);
      return res.status(502).json({ error: 'Failed to cancel subscription with payment provider' });
    }

    const whopData = await whopRes.json();
    console.log(`Whop cancel success for membership ${membership.whop_membership_id}:`, whopData.status);

    // 6. Update local membership record
    const { error: updateError } = await supabase
      .from('memberships')
      .update({
        cancel_at_period_end: true,
        status: 'canceling',
      })
      .eq('id', membership.id);

    if (updateError) {
      console.error('Failed to update local membership:', updateError);
      // Still return success — the Whop cancellation went through,
      // and the webhook will eventually sync the status
    }

    return res.status(200).json({
      success: true,
      message: 'Subscription will cancel at the end of your billing period',
      renewal_period_end: membership.renewal_period_end,
    });
  } catch (err) {
    console.error('Cancel request failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
