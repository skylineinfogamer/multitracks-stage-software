// Supabase Edge Function: infinitepay-webhook
// Runtime: Deno (TypeScript)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const rawBody = await req.text();
    let payload: any = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[InfinitePay Webhook] Recebido evento:", payload);

    // 1. Signature check (se configurado no ambiente)
    const expectedSecret = Deno.env.get("INFINITEPAY_WEBHOOK_SECRET");
    const signature = req.headers.get("x-signature") || req.headers.get("authorization");
    if (expectedSecret && signature && !signature.includes(expectedSecret)) {
      console.warn("[InfinitePay Webhook] Assinatura inválida:", signature);
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Extrai status do pagamento
    const eventType = payload.event || payload.type || "";
    const status = payload.status || payload.data?.status || payload.charge?.status || "";

    const isPaid =
      eventType.includes("paid") ||
      eventType.includes("approved") ||
      status === "paid" ||
      status === "approved" ||
      status === "settled";

    if (!isPaid) {
      console.log(`[InfinitePay Webhook] Evento ignorado (status = ${status || eventType})`);
      return new Response(JSON.stringify({ received: true, ignored: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Extrai o ID do usuário dos metadados
    const metadata = payload.metadata || payload.data?.metadata || payload.charge?.metadata || {};
    const userId = metadata.user_id || payload.user_id || payload.customer_id;
    const planId = metadata.plan_id || "monthly";

    if (!userId) {
      console.warn("[InfinitePay Webhook] userId não encontrado no metadata do payload:", payload);
      return new Response(
        JSON.stringify({ error: "No userId provided in metadata." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Conecta com permissões de Service Role no Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados no ambiente.");
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // 5. Atualiza a tabela public.profiles para 'active'
    // Isso dispara o Supabase Realtime imediatamente para o frontend!
    const { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from("profiles")
      .update({
        status: "active",
      })
      .eq("id", userId)
      .select()
      .maybeSingle();

    if (updateError) {
      console.error("[InfinitePay Webhook] Erro ao atualizar profiles:", updateError);
      throw updateError;
    }

    console.log(`[InfinitePay Webhook] Sucesso! Usuário ${userId} ativado com plano ${planId}:`, updatedProfile);

    return new Response(
      JSON.stringify({
        received: true,
        activated: true,
        userId,
        planId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[InfinitePay Webhook] Erro de processamento:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
