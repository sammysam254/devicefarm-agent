import { supabase } from './supabase';

export const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "BDfYf78UGUsVFs6WGFbo8g2Y4qleyEIl4iBZN7mxGkGaFjU69urLy54sFdxM8Za8IOeHYmov11AW5gqfdXXD2Ys";
export const VAPID_SUBJECT = import.meta.env.VITE_VAPID_SUBJECT || "mailto:Sammyseth260@gmail.com";

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

    // Ensure the subscription matches the current VAPID_PUBLIC_KEY
    const savedKey = localStorage.getItem('df_vapid_key');
    if (savedKey !== VAPID_PUBLIC_KEY && sub) {
      console.log('[Push] VAPID key updated, renewing push subscription...');
      try {
        await sub.unsubscribe();
      } catch (_) {}
      sub = null;
    }

    // If no subscription or renewed, subscribe using the user's hardcoded VAPID public key
    if (!sub) {
      try {
        const convertedVapidKey = urlB64ToUint8Array(VAPID_PUBLIC_KEY);
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: convertedVapidKey
        });
        localStorage.setItem('df_vapid_key', VAPID_PUBLIC_KEY);
        console.log('[Push] Subscribed to browser push manager successfully with VAPID key.');
      } catch (subErr) {
        console.warn('[Push] PushManager subscribe error:', subErr);
      }
    } else {
      localStorage.setItem('df_vapid_key', VAPID_PUBLIC_KEY);
    }

    if (sub) {
      const p256dh = sub.getKey ? btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('p256dh')))) : null;
      const auth = sub.getKey ? btoa(String.fromCharCode.apply(null, new Uint8Array(sub.getKey('auth')))) : null;

      const { error } = await supabase
        .from('push_subscriptions')
        .upsert({
          user_id: userId || null,
          chat_code: chatCode,
          endpoint: sub.endpoint,
          p256dh,
          auth,
          updated_at: new Date().toISOString()
        }, { onConflict: 'endpoint' });

      if (error) {
        console.warn('[Push] Error saving push subscription in Supabase:', error);
      } else {
        console.log('[Push] Synced device push subscription for User Chat Code:', chatCode);
      }
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
    // 1. Invoke Supabase Edge Function to push to Google/Apple/Mozilla push gateways
    supabase.functions.invoke('send-call-push', {
      body: {
        recipientChatCode,
        sessionId: callSession.id,
        callerEmail: callSession.caller_email,
        callerChatCode: callSession.caller_chat_code
      }
    }).then(({ data, error }) => {
      if (error) {
        console.warn('[Push] Edge function send-call-push invoke warning:', error);
      } else {
        console.log('[Push] Edge function push sent result:', data);
      }
    }).catch(() => {});

    // 2. Broadcast high-priority alert across Realtime channel
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
  } catch (err) {
    console.warn('[Push] Dispatch offline call alert error:', err);
  }
}

/**
 * Dispatch an offline chat message push notification to recipient's registered devices
 */
export async function dispatchOfflineMessagePush(recipientChatCode, messageData) {
  if (!recipientChatCode || !messageData) return;

  try {
    supabase.functions.invoke('send-call-push', {
      body: {
        type: 'message',
        recipientChatCode,
        messageId: messageData.id,
        messageText: messageData.message,
        senderEmail: messageData.sender_email,
        senderChatCode: messageData.sender_chat_code
      }
    }).catch(() => {});
  } catch (err) {
    console.warn('[Push] Dispatch message push error:', err);
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
