// Supabase Edge Function: send-call-push
// Wakes up offline devices via Web Push (FCM, Apple, Mozilla)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = "BDfYf78UGUsVFs6WGFbo8g2Y4qleyEIl4iBZN7mxGkGaFjU69urLy54sFdxM8Za8IOeHYmov11AW5gqfdXXD2Ys";
const VAPID_PRIVATE_KEY = "tYgIE8QmZxM2DxPOMmwKJqYxhR8aBqm1ANne_5gVPSg";
const VAPID_SUBJECT = "mailto:Sammyseth260@gmail.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { 
      type, 
      recipientChatCode, 
      sessionId, 
      callerEmail, 
      callerChatCode,
      senderEmail,
      senderChatCode,
      messageText,
      messageId 
    } = await req.json();

    if (!recipientChatCode) {
      return new Response(JSON.stringify({ error: "Missing recipientChatCode" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase Admin Client
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch active push subscriptions for the recipient
    const { data: subscriptions, error } = await supabase
      .from("push_subscriptions")
      .select("*")
      .eq("chat_code", recipientChatCode);

    if (error) {
      console.error("[send-call-push] Error fetching subscriptions:", error);
      throw error;
    }

    if (!subscriptions || subscriptions.length === 0) {
      console.log(`[send-call-push] No push subscriptions found for User #${recipientChatCode}`);
      return new Response(JSON.stringify({ success: true, sent: 0, reason: "no_subscriptions" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isMessage = type === "message";
    const title = isMessage 
      ? `💬 Message from ${senderEmail || `User #${senderChatCode}`}`
      : "📞 Incoming Voice Call";

    const body = isMessage
      ? (messageText || "You received a new message on FlexPulse.")
      : `${callerEmail || `User #${callerChatCode}`} is calling you on FlexPulse! Tap to answer.`;

    const tag = isMessage ? `msg-${messageId || Date.now()}` : `voice-call-${sessionId}`;

    const payload = JSON.stringify({
      title,
      body,
      tag,
      type: isMessage ? "message" : "call",
      sessionId,
      chatCode: isMessage ? senderChatCode : callerChatCode,
      url: `/messages`,
    });

    let sentCount = 0;
    const expiredIds = [];

    // Send push to each registered device endpoint (Phone, PC, etc.)
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          const pushSubscription = {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
          };

          await webpush.sendNotification(pushSubscription, payload, {
            TTL: 45, // 45 seconds timeout matching call ringing window
            urgency: "high",
          });
          sentCount++;
          console.log(`[send-call-push] Successfully pushed to endpoint: ${sub.endpoint.slice(0, 30)}...`);
        } catch (err) {
          console.warn("[send-call-push] Failed to push to endpoint:", err.statusCode || err.message);
          // 404 or 410 means subscription is expired or unregistered
          if (err.statusCode === 410 || err.statusCode === 404) {
            expiredIds.push(sub.id);
          }
        }
      })
    );

    // Clean up expired subscriptions
    if (expiredIds.length > 0) {
      await supabase.from("push_subscriptions").delete().in("id", expiredIds);
      console.log(`[send-call-push] Cleaned up ${expiredIds.length} expired subscriptions.`);
    }

    return new Response(JSON.stringify({ success: true, sent: sentCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[send-call-push] Unhandled error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
