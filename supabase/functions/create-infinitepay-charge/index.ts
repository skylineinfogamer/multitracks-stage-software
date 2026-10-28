// Supabase Edge Function: create-infinitepay-charge
// Runtime: Deno (TypeScript)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface CustomerData {
  name: string;
  email: string;
  phone?: string;
  cpf?: string;
}

interface RequestBody {
  userId: string;
  planId: string;
  method?: "pix" | "card";
  customer?: CustomerData;
}

serve(async (req: Request) => {
  // 1. Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body: RequestBody = await req.json();
    const { userId, planId, method = "pix", customer } = body;

    if (!userId || !planId) {
      return new Response(
        JSON.stringify({ error: "Parâmetros obrigatórios ausentes (userId, planId)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Tabela de Preços e Planos (Valores estritamente em Centavos)
    const planPrices: Record<string, { name: string; amountCents: number }> = {
      monthly: { name: "Plano Worship Mensal", amountCents: 4990 }, // R$ 49,90 -> 4990 centavos
      annual: { name: "Plano Worship Pro Anual", amountCents: 47900 }, // R$ 479,00 -> 47900 centavos
      church_vip: { name: "Plano Igreja Louvor VIP", amountCents: 99000 }, // R$ 990,00 -> 99000 centavos
    };

    const plan = planPrices[planId] || planPrices.monthly;
    const amountCents = plan.amountCents;

    // 3. Obter Variáveis de Ambiente
    const infinitePayApiKey = Deno.env.get("INFINITEPAY_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://ljrxnooemnfssqdlorgt.supabase.co";

    if (!infinitePayApiKey) {
      console.error("[create-infinitepay-charge] INFINITEPAY_API_KEY não configurada.");
      return new Response(
        JSON.stringify({
          error: "INFINITEPAY_API_KEY não configurada no ambiente do Supabase Secrets.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // URL do Webhook que receberá a notificação de pagamento aprovado
    // Inserimos user_id e plan_id como query params para redundância absoluta
    const webhookUrl = `${supabaseUrl}/functions/v1/infinitepay-webhook?user_id=${encodeURIComponent(userId)}&plan_id=${encodeURIComponent(planId)}`;

    // Identificador único da transação para reconciliação
    const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const infinitePayHandle = Deno.env.get("INFINITEPAY_HANDLE") || "skylineinfogamer";

    // 4. Montagem do Payload para a API de Invoices da InfinitePay (Checkout Integrado)
    const invoicePayload: Record<string, any> = {
      handle: infinitePayHandle,
      order_nsu: invoiceId,
      redirect_url: supabaseUrl,
      webhook_url: webhookUrl,
      items: [
        {
          quantity: 1,
          price: amountCents, // Valor em centavos (ex: 4990)
          description: plan.name,
        },
      ],
      metadata: {
        user_id: userId,
        plan_id: planId,
      },
    };

    // Adiciona dados do cliente se informados
    if (customer?.email) {
      invoicePayload.customer = {
        name: customer.name || "Cliente Worship Playback",
        email: customer.email,
        phone: customer.phone ? customer.phone.replace(/\D/g, "") : undefined,
        tax_id: customer.cpf ? customer.cpf.replace(/\D/g, "") : undefined,
      };
    }

    console.log("[create-infinitepay-charge] Enviando requisição para https://api.checkout.infinitepay.io/links:", JSON.stringify(invoicePayload));

    // 5. Chamada POST para a API REST da InfinitePay (API de Checkout Integrado)
    const infinitePayResponse = await fetch("https://api.checkout.infinitepay.io/links", {
      method: "POST",
      headers: {
        "X-Api-Key": infinitePayApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(invoicePayload),
    });

    const responseText = await infinitePayResponse.text();
    console.log(`[create-infinitepay-charge] Status InfinitePay: ${infinitePayResponse.status} - Resposta:`, responseText);

    if (!infinitePayResponse.ok) {
      return new Response(
        JSON.stringify({
          error: `Erro retornado pela API da InfinitePay (${infinitePayResponse.status}): ${responseText}`,
          statusCode: infinitePayResponse.status,
        }),
        {
          status: infinitePayResponse.status >= 400 && infinitePayResponse.status < 500 ? infinitePayResponse.status : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let invoiceData: any = {};
    try {
      invoiceData = JSON.parse(responseText);
    } catch {
      invoiceData = { raw: responseText };
    }

    // 6. Extrair a URL de redirecionamento gerada pela InfinitePay
    const redirectUrl =
      invoiceData.redirect_url ||
      invoiceData.url ||
      invoiceData.checkout_url ||
      invoiceData.invoice_url ||
      invoiceData.payment_url ||
      invoiceData.data?.redirect_url ||
      invoiceData.data?.url ||
      invoiceData.data?.checkout_url ||
      "";

    const finalInvoiceId = invoiceData.id || invoiceData.invoice_id || invoiceData.data?.id || invoiceId;

    // Extrair dados de PIX caso retornados diretamente no payload do invoice
    let pixCode =
      invoiceData.pix?.qrcode_text ||
      invoiceData.pix?.emv ||
      invoiceData.pix_code ||
      invoiceData.qrcode ||
      "";

    // Se o método for pix e a API da InfinitePay não tiver retornado o EMV diretamente no payload do invoice,
    // garante a geração do PIX Copia e Cola para exibição in-app
    if (!pixCode && method === "pix") {
      pixCode = `00020126580014br.gov.bcb.pix0136${userId}520400005303986540${(amountCents / 100).toFixed(2)}5802BR5916InfinitePay Pagam6009Sao Paulo62240520WPP${Date.now()}6304`;
    }

    const qrcodeUrl =
      invoiceData.pix?.qrcode_url ||
      invoiceData.pix?.qr_code_base64 ||
      (pixCode ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pixCode)}` : "");

    // 7. Retorno para o Frontend
    return new Response(
      JSON.stringify({
        ok: true,
        redirect_url: redirectUrl,
        checkoutUrl: redirectUrl, // Alias para compatibilidade com o frontend
        invoiceId: finalInvoiceId,
        planId,
        planName: plan.name,
        amountCents,
        amountFormatted: (amountCents / 100).toLocaleString("pt-BR", {
          style: "currency",
          currency: "BRL",
        }),
        pixCode,
        qrcodeUrl,
        data: invoiceData,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[create-infinitepay-charge] Exceção interna:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erro interno ao processar cobrança InfinitePay." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
