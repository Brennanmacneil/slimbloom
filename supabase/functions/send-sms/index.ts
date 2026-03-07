// send-sms: Triggered by database webhook on phone_leads INSERT
// Sends the first welcome SMS immediately via Twilio
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

async function sendTwilioSMS(to: string, body: string): Promise<string | null> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`
  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: to,
      From: TWILIO_PHONE_NUMBER,
      Body: body,
    }),
  })

  const data = await resp.json()
  if (resp.ok) {
    return data.sid
  } else {
    console.error('Twilio error:', data)
    return null
  }
}

serve(async (req) => {
  try {
    const payload = await req.json()
    // Database webhook sends the new row as payload.record
    const record = payload.record || payload

    const phone = record.phone
    if (!phone) {
      return new Response(JSON.stringify({ error: 'No phone number' }), { status: 400 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Get the first non_converter campaign message (step 1, delay 0)
    const { data: campaign } = await supabase
      .from('sms_campaigns')
      .select('*')
      .eq('campaign_type', 'non_converter')
      .eq('step_number', 1)
      .eq('active', true)
      .single()

    if (!campaign) {
      return new Response(JSON.stringify({ error: 'No campaign message found' }), { status: 404 })
    }

    // Wait 60 seconds before sending so it doesn't feel instant/automated
    await new Promise(resolve => setTimeout(resolve, 60000))

    // Send the welcome SMS
    const twilioSid = await sendTwilioSMS(phone, campaign.message_template)

    // Log the sent message
    await supabase.from('sms_log').insert({
      phone_lead_id: record.id,
      campaign_id: campaign.id,
      phone: phone,
      message_body: campaign.message_template,
      status: twilioSid ? 'sent' : 'failed',
      twilio_sid: twilioSid,
      sent_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ success: true, twilio_sid: twilioSid }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('send-sms error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
