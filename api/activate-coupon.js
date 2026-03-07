import { createClient } from '@supabase/supabase-js';

const VALID_COUPONS = {
  LAZY: { plan_name: 'Free 30-Day Access', duration_days: 30 },
};

export default async function handler(req, res) {
  // CORS
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Extract JWT
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.replace('Bearer ', '');

  // 2. Validate coupon code from body
  const { coupon } = req.body || {};
  const code = (coupon || '').trim().toUpperCase();
  const couponConfig = VALID_COUPONS[code];
  if (!couponConfig) {
    return res.status(400).json({ error: 'Invalid coupon code' });
  }

  // 3. Init Supabase with service role
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 4. Verify user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // 5. Check if user already has an active membership
  const { data: existing } = await supabase
    .from('memberships')
    .select('id')
    .eq('user_id', user.id)
    .in('status', ['active', 'trialing'])
    .limit(1);

  if (existing && existing.length > 0) {
    return res.status(200).json({ success: true, message: 'Already has active membership' });
  }

  // 6. Check if this user already redeemed a coupon (prevent abuse)
  const couponMembershipId = `coupon_${code}_${user.id}`;
  const { data: alreadyRedeemed } = await supabase
    .from('memberships')
    .select('id')
    .eq('whop_membership_id', couponMembershipId)
    .limit(1);

  if (alreadyRedeemed && alreadyRedeemed.length > 0) {
    return res.status(400).json({ error: 'Coupon already redeemed' });
  }

  // 7. Create membership record
  const now = new Date();
  const expiresAt = new Date(now.getTime() + couponConfig.duration_days * 24 * 60 * 60 * 1000);

  const { data: membership, error: insertError } = await supabase
    .from('memberships')
    .insert({
      whop_membership_id: couponMembershipId,
      whop_plan_id: `coupon_${code}`,
      whop_user_email: user.email || '',
      user_id: user.id,
      status: 'active',
      plan_name: couponConfig.plan_name,
      plan_price_cents: 0,
      plan_interval: 'month',
      renewal_period_start: now.toISOString(),
      renewal_period_end: expiresAt.toISOString(),
      cancel_at_period_end: true,
      canceled_at: null,
    })
    .select()
    .single();

  if (insertError) {
    console.error('Failed to create coupon membership:', insertError);
    return res.status(500).json({ error: 'Failed to activate coupon' });
  }

  console.log(`Coupon ${code} activated for user ${user.id}, expires ${expiresAt.toISOString()}`);
  return res.status(200).json({ success: true, membership });
}
