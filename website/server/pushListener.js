// Standalone Node.js Web Push Dispatcher for Offline Calls
// Can run as a system daemon, background worker, or PM2 process
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lazdyihryfvrlczczvxz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhemR5aWhyeWZ2cmxjemN6dnh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNzYxNjgsImV4cCI6MjEwMjk1MjE2OH0.fUBdMbDgV8e0Fk4mfVB8DqQc88vrw8oA6MdHXHFsXAs';

const VAPID_PUBLIC_KEY = 'BDfYf78UGUsVFs6WGFbo8g2Y4qleyEIl4iBZN7mxGkGaFjU69urLy54sFdxM8Za8IOeHYmov11AW5gqfdXXD2Ys';
const VAPID_PRIVATE_KEY = 'tYgIE8QmZxM2DxPOMmwKJqYxhR8aBqm1ANne_5gVPSg';
const VAPID_SUBJECT = 'mailto:Sammyseth260@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('[PushListener] Starting Web Push Listener for offline calls...');
console.log('[PushListener] VAPID Subject:', VAPID_SUBJECT);
console.log('[PushListener] Public Key:', VAPID_PUBLIC_KEY.slice(0, 20) + '...');

// Send push notification to all devices registered for chatCode
export async function sendCallPush(recipientChatCode, session) {
  try {
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('chat_code', recipientChatCode);

    if (error) {
      console.error('[PushListener] Error querying subscriptions:', error);
      return;
    }

    if (!subs || subs.length === 0) {
      console.log(`[PushListener] No device registered in push_subscriptions for User #${recipientChatCode}`);
      return;
    }

    const payload = JSON.stringify({
      title: '📞 Incoming Voice Call',
      body: `${session.caller_email || `User #${session.caller_chat_code}`} is calling you on FlexPulse! Tap to answer.`,
      tag: `voice-call-${session.id}`,
      sessionId: session.id,
      chatCode: session.caller_chat_code,
      callerEmail: session.caller_email,
      url: `/messages?call=${session.id}`
    });

    console.log(`[PushListener] Sending push to ${subs.length} device(s) for User #${recipientChatCode}...`);

    for (const sub of subs) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        }, payload, {
          TTL: 45,
          urgency: 'high'
        });
        console.log(`[PushListener] Successfully sent push to device endpoint: ${sub.endpoint.slice(0, 35)}...`);
      } catch (err) {
        console.warn(`[PushListener] Device push failed:`, err.statusCode || err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
          console.log(`[PushListener] Removed expired subscription ID: ${sub.id}`);
        }
      }
    }
  } catch (err) {
    console.error('[PushListener] Failed to dispatch call push:', err);
  }
}

// Send message push notification to all devices registered for chatCode
export async function sendMessagePush(recipientChatCode, msg) {
  try {
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('chat_code', recipientChatCode);

    if (error || !subs || subs.length === 0) return;

    const payload = JSON.stringify({
      title: `💬 Message from ${msg.sender_email || `User #${msg.sender_chat_code}`}`,
      body: msg.message,
      tag: `msg-${msg.id}`,
      type: 'message',
      chatCode: msg.sender_chat_code,
      senderEmail: msg.sender_email,
      url: `/messages`
    });

    console.log(`[PushListener] Sending message push to ${subs.length} device(s) for User #${recipientChatCode}...`);

    for (const sub of subs) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        }, payload, {
          TTL: 86400,
          urgency: 'normal'
        });
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    }
  } catch (err) {
    console.error('[PushListener] Failed to dispatch message push:', err);
  }
}

// Subscribe to Realtime call_sessions and chat_messages INSERT events
const channel = supabase
  .channel('call-and-msg-push-dispatcher')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'call_sessions'
  }, async (payload) => {
    const session = payload.new;
    if (session && session.status === 'ringing') {
      console.log(`[PushListener] Detected incoming call session: ${session.id} -> Recipient #${session.recipient_chat_code}`);
      await sendCallPush(session.recipient_chat_code, session);
    }
  })
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'chat_messages'
  }, async (payload) => {
    const msg = payload.new;
    if (msg && !msg.is_read) {
      console.log(`[PushListener] Detected incoming chat message: ${msg.id} -> Recipient #${msg.recipient_chat_code}`);
      await sendMessagePush(msg.recipient_chat_code, msg);
    }
  })
  .subscribe((status) => {
    console.log('[PushListener] Realtime subscription status:', status);
  });
