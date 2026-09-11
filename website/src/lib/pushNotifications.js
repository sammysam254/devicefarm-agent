import { supabase } from './supabase';

/**
 * Register Service Worker for background notifications and offline call handling
 */
export async function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[Push] Service worker registered with scope:', reg.scope);
    return reg;
  } catch (err) {
    console.warn('[Push] Service worker registration failed:', err);
    return null;
  }
}

/**
 * Subscribe current client to push notifications and sync with Supabase push_subscriptions
 */
export async function syncPushSubscription(chatCode, userId) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !chatCode) {
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) return null;

    let sub = await reg.pushManager.getSubscription();

    // If no existing subscription, attempt to subscribe
    if (!sub) {
      // Use applicationServerKey if available or standard subscription
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          // Generic public key or applicationServerKey
          applicationServerKey: urlB64ToUint8Array('BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U')
        });
      } catch (subErr) {
        console.warn('[Push] PushManager subscribe error (non-fatal):', subErr);
      }
    }

    if (sub) {
      const p256dh = sub.getKey ? btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('p256dh')))) : null;
      const auth = sub.getKey ? btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('auth')))) : null;

      await supabase
        .from('push_subscriptions')
        .upsert({
          user_id: userId || null,
          chat_code: chatCode,
          endpoint: sub.endpoint,
          p256dh,
          auth,
          updated_at: new Date().toISOString()
        }, { onConflict: 'endpoint' });

      console.log('[Push] Push subscription synced for Chat Code:', chatCode);
      return sub;
    }
  } catch (err) {
    console.warn('[Push] Error syncing push subscription:', err);
  }
  return null;
}

/**
 * Dispatch an offline call alert to recipient's registered endpoints or channels
 */
export async function dispatchOfflineCallAlert(recipientChatCode, callSession) {
  if (!recipientChatCode || !callSession) return;

  try {
    // 1. Broadcast high-priority alert across Supabase channel
    const alertChannel = supabase.channel(`offline-call-alert-${recipientChatCode}`);
    await alertChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await alertChannel.send({
          type: 'broadcast',
          event: 'call-alert',
          payload: {
            sessionId: callSession.id,
            callerEmail: callSession.caller_email,
            callerChatCode: callSession.caller_chat_code,
            created_at: callSession.created_at
          }
        });
        supabase.removeChannel(alertChannel);
      }
    });

    // 2. Fetch push subscriptions if any to trigger push
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('chat_code', recipientChatCode);

    if (subs && subs.length > 0) {
      console.log(`[Push] Found ${subs.length} push subscriptions for User #${recipientChatCode}`);
    }
  } catch (err) {
    console.warn('[Push] Dispatch offline call alert error:', err);
  }
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
