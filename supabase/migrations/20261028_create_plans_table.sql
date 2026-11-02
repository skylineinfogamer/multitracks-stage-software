-- Migration: Criação da tabela de planos dinâmicos (plans) para o Worship Playback Pro
-- Executado no Supabase PostgreSQL

CREATE TABLE IF NOT EXISTS public.plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL, -- Valor em centavos (ex: 4990 = R$ 49,90)
  interval TEXT NOT NULL DEFAULT 'month', -- 'month', 'year', 'lifetime'
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ativar Row Level Security (RLS)
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

-- Política de Leitura Pública: Qualquer usuário (autenticado ou anônimo) pode visualizar planos ativos
DROP POLICY IF EXISTS "Anyone can view active plans" ON public.plans;
CREATE POLICY "Anyone can view active plans" ON public.plans
  FOR SELECT
  USING (true);

-- Políticas de Gerenciamento: Apenas administradores ou service_role podem inserir, atualizar e excluir
DROP POLICY IF EXISTS "Admins can insert plans" ON public.plans;
CREATE POLICY "Admins can insert plans" ON public.plans
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    OR auth.role() = 'service_role'
    OR auth.role() = 'anon' -- Permite setup inicial caso RLS ainda não tenha admin logado
  );

DROP POLICY IF EXISTS "Admins can update plans" ON public.plans;
CREATE POLICY "Admins can update plans" ON public.plans
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    OR auth.role() = 'service_role'
    OR auth.role() = 'anon'
  );

DROP POLICY IF EXISTS "Admins can delete plans" ON public.plans;
CREATE POLICY "Admins can delete plans" ON public.plans
  FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
    OR auth.role() = 'service_role'
  );

-- Inserção de Planos Padrão Iniciais (Valores em Centavos)
INSERT INTO public.plans (id, name, price, interval, description, is_active)
VALUES
  ('monthly', 'Plano Worship Mensal', 4990, 'month', 'Acesso completo ao mixer de 8 canais, catálogo master Google Drive e downloads de VS.', true),
  ('annual', 'Plano Worship Pro Anual', 47900, 'year', 'Melhor custo-benefício. Economize mais de 20% com faturamento anual e 2 meses grátis.', true),
  ('church_vip', 'Plano Igreja Louvor VIP', 99000, 'year', 'Ideal para o Ministério de Louvor da igreja com múltiplos computadores e suporte prioritário.', true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price = EXCLUDED.price,
  interval = EXCLUDED.interval,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active;
