import { Webhook } from 'svix';
import { createClient } from '@supabase/supabase-js';

// Disable Vercel's default body parser so we get the raw body for signature verification
export const config = {
  api: { bodyParser: false },
};

// Plan ID → human-readable details
const PLAN_MAP = {
  'plan_VWsf3Cik0o7Vj': { name: '4-Week Plan', price_cents: 1999, interval: 'month' },
  'plan_CGt8PI0ipZ9vR': { name: '12-Week Plan', price_cents: 3999, interval: '3-months' },
  'plan_KJiJ7FZ8lj9OR': { name: '24-Week Plan', price_cents: 5999, interval: '6-months' },
};

// Read raw body from the request stream
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Read raw body for signature verification
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('Failed to read body:', err);
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  // 2. Verify webhook signature
  const wh = new Webhook(process.env.WHOP_WEBHOOK_SECRET);
  let payload;
  try {
    payload = wh.verify(rawBody, {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    });
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  // 3. Extract event data
  const eventType = payload.type || 'unknown';
  const membership = payload.data || {};
  const whopEmail = membership.user?.email || membership.email || '';
  const whopMembershipId = membership.id;
  const whopPlanId = membership.plan?.id || membership.plan_id || '';

  console.log(`Webhook received: ${eventType}, membership: ${whopMembershipId}, email: ${whopEmail}`);

  if (!whopMembershipId) {
    console.error('Missing membership ID in webhook payload');
    return res.status(400).json({ error: 'Missing membership ID' });
  }

  // 4. Initialize Supabase with service role key (bypasses RLS)
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 5. Try to find the Supabase Auth user by email
  let userId = null;
  if (whopEmail) {
    try {
      const { data: usersData } = await supabase.auth.admin.listUsers();
      const matchedUser = usersData?.users?.find(
        (u) => u.email?.toLowerCase() === whopEmail.toLowerCase()
      );
      if (matchedUser) {
        userId = matchedUser.id;
      }
    } catch (err) {
      console.error('Failed to look up user by email:', err.message);
      // Continue without linking — lazy linking will catch it later
    }
  }

  // 6. Map plan details
  const planDetails = PLAN_MAP[whopPlanId] || {
    name: 'Unknown Plan',
    price_cents: 0,
    interval: 'unknown',
  };

  // 7. Determine status
  let status = membership.status || 'active';
  if (membership.cancel_at_period_end && status === 'active') {
    status = 'canceling';
  }

  // 8. Upsert membership record
  const { error } = await supabase.from('memberships').upsert(
    {
      whop_membership_id: whopMembershipId,
      whop_plan_id: whopPlanId,
      whop_user_email: whopEmail,
      whop_user_id: membership.user?.id || null,
      user_id: userId,
      status: status,
      plan_name: planDetails.name,
      plan_price_cents: planDetails.price_cents,
      plan_interval: planDetails.interval,
      renewal_period_start: membership.renewal_period_start || null,
      renewal_period_end: membership.renewal_period_end || null,
      cancel_at_period_end: membership.cancel_at_period_end || false,
      canceled_at: membership.canceled_at || null,
    },
    { onConflict: 'whop_membership_id' }
  );

  if (error) {
    console.error('Supabase upsert error:', error);
    return res.status(500).json({ error: 'Database error' });
  }

  console.log(`Membership ${whopMembershipId} upserted successfully (status: ${status})`);
  return res.status(200).json({ success: true });
}
