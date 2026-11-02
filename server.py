import os
import sys
import json
import shutil
import tempfile
import threading
import webbrowser
import subprocess
from datetime import datetime, timedelta

# Modo Worker CLI do B2 para portabilidade total (funciona tanto no script quanto compilado em .exe)
if len(sys.argv) > 1 and sys.argv[1] == '--b2-worker':
    try:
        from b2._internal.b2v5.registry import main
        sys.argv = ['b2'] + sys.argv[2:]
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(f"Erro no B2 Worker: {exc}\n")
        sys.exit(1)

from flask import Flask, request, jsonify, send_from_directory, session

# ══════════════════════════════════════════════════════════════════════════════
# Configuração do Supabase (Chave Service Role já embarcada)
# ══════════════════════════════════════════════════════════════════════════════
EMBEDDED_SUPABASE_SERVICE_KEY = (
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
    'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxqcnhub29lbW5mc3NxZGxvcmd0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MzEzNDc1NCwiZXhwIjoyMTA4NzEwNzU0fQ.'
    '583_LOFVm9VUICXFjnArFm2UYRPd7le6eqV-amT8hlE'
)

SUPABASE_URL = os.environ.get(
    'SUPABASE_URL',
    os.environ.get('VITE_SUPABASE_URL', 'https://ljrxnooemnfssqdlorgt.supabase.co')
)
SUPABASE_ANON_KEY = os.environ.get(
    'SUPABASE_ANON_KEY',
    os.environ.get('VITE_SUPABASE_ANON_KEY', 'sb_publishable_evrZKVsm83zueAdT3zDzIQ_udMTgpWN')
)
SUPABASE_SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', EMBEDDED_SUPABASE_SERVICE_KEY)

# Carregar arquivo .env local se existir
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.isfile(env_path):
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip()
                    if k and v and k not in os.environ:
                        os.environ[k] = v
        SUPABASE_URL = os.environ.get('SUPABASE_URL', os.environ.get('VITE_SUPABASE_URL', SUPABASE_URL))
        SUPABASE_ANON_KEY = os.environ.get('SUPABASE_ANON_KEY', os.environ.get('VITE_SUPABASE_ANON_KEY', SUPABASE_ANON_KEY))
        skey = os.environ.get('SUPABASE_SERVICE_KEY', '')
        if skey:
            SUPABASE_SERVICE_KEY = skey
    except Exception:
        pass

_supabase_client = None
_supabase_anon_client = None

def get_supabase_client(service_key=None, require_service=False):
    """Retorna client Supabase. Usa Service Key se fornecida/disponível, ou Anon Key como fallback."""
    global _supabase_client, _supabase_anon_client, SUPABASE_SERVICE_KEY
    key = service_key or SUPABASE_SERVICE_KEY
    if not key:
        if require_service:
            return None
        key = SUPABASE_ANON_KEY
    if not key:
        return None
    try:
        from supabase import create_client
        if service_key or (key == SUPABASE_SERVICE_KEY and SUPABASE_SERVICE_KEY):
            if _supabase_client is None or service_key:
                _supabase_client = create_client(SUPABASE_URL, key)
                if service_key:
                    SUPABASE_SERVICE_KEY = service_key
            return _supabase_client
        else:
            if _supabase_anon_client is None:
                _supabase_anon_client = create_client(SUPABASE_URL, key)
            return _supabase_anon_client
    except Exception:
        return None

# ══════════════════════════════════════════════════════════════════════════════
# Armazenamento Local (apenas cache e novos membros criados localmente)
# ══════════════════════════════════════════════════════════════════════════════
LOCAL_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
LOCAL_MEMBERS_FILE = os.path.join(LOCAL_DATA_DIR, 'local_members.json')

def load_local_members():
    """Carrega membros locais. Sem dados fictícios."""
    os.makedirs(LOCAL_DATA_DIR, exist_ok=True)
    if not os.path.isfile(LOCAL_MEMBERS_FILE):
        return []
    try:
        with open(LOCAL_MEMBERS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []

def save_local_members(members):
    """Salva a base de membros localmente."""
    os.makedirs(LOCAL_DATA_DIR, exist_ok=True)
    with open(LOCAL_MEMBERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(members, f, ensure_ascii=False, indent=2)

# ══════════════════════════════════════════════════════════════════════════════
# Flask App Setup
# ══════════════════════════════════════════════════════════════════════════════
def get_base_dir():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))

static_folder_path = os.path.join(get_base_dir(), 'public')
app = Flask(__name__, static_folder=static_folder_path, static_url_path='')
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'worship-playback-pro-admin-key-2026-secure')

# ══════════════════════════════════════════════════════════════════════════════
# Autenticação de Administrador
# ══════════════════════════════════════════════════════════════════════════════
ADMIN_USERNAME = 'admin'
ADMIN_PASSWORD = '87datnow'

@app.before_request
def check_admin_session():
    # Permitir arquivos estáticos (HTML, JS, CSS, assets) e endpoints de login
    if not request.path.startswith('/api/'):
        return None
    if request.path.startswith('/api/auth/'):
        return None
    # Permitir requisições com autenticação de sessão ou token
    if session.get('is_admin_authenticated'):
        return None
    auth_header = request.headers.get('Authorization', '')
    if auth_header == f'Bearer {ADMIN_PASSWORD}':
        return None
    return jsonify({
        'success': False,
        'authenticated': False,
        'message': 'Acesso restrito. Faça login como administrador para continuar.'
    }), 401

@app.route('/api/auth/status', methods=['GET'])
def auth_status():
    is_auth = session.get('is_admin_authenticated', False)
    return jsonify({
        'authenticated': is_auth,
        'user': ADMIN_USERNAME if is_auth else None
    })

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get('username', '')).strip().lower()
    password = str(data.get('password', '')).strip()

    if username == ADMIN_USERNAME.lower() and password == ADMIN_PASSWORD:
        session['is_admin_authenticated'] = True
        return jsonify({
            'success': True,
            'message': 'Autenticado com sucesso! Bem-vindo ao Worship Playback Pro.',
            'user': ADMIN_USERNAME
        })
    else:
        return jsonify({
            'success': False,
            'message': 'Usuário ou senha de administrador incorretos.'
        }), 401

@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    session.pop('is_admin_authenticated', None)
    return jsonify({'success': True, 'message': 'Sessão encerrada com sucesso.'})

# ══════════════════════════════════════════════════════════════════════════════
# B2 Execution Engine
# ══════════════════════════════════════════════════════════════════════════════
def get_b2_exec_cmd(args):
    known_b2_paths = [
        r"C:\Users\leand\AppData\Local\Programs\Python\Python312\Scripts\b2.exe",
        os.path.join(os.path.dirname(sys.executable), "Scripts", "b2.exe"),
        os.path.join(sys.prefix, "Scripts", "b2.exe"),
        shutil.which("b2.exe") or "",
        shutil.which("b2") or ""
    ]
    for path in known_b2_paths:
        if path and os.path.isfile(path):
            return [path] + args

    if getattr(sys, 'frozen', False):
        return [sys.executable, '--b2-worker'] + args
    else:
        current_script = os.path.abspath(__file__)
        return [sys.executable, current_script, '--b2-worker'] + args

def execute_b2(args, timeout=1800):
    cmd = get_b2_exec_cmd(args)
    startupinfo = None
    if os.name == 'nt':
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding='utf-8',
        errors='replace', timeout=timeout, startupinfo=startupinfo
    )
    return cmd, result

# ══════════════════════════════════════════════════════════════════════════════
# Rotas: B2
# ══════════════════════════════════════════════════════════════════════════════
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/api/account', methods=['GET'])
def get_account_status():
    try:
        cmd, result = execute_b2(['account', 'get'], timeout=15)
        if result.returncode == 0:
            return jsonify({'authenticated': True, 'raw': result.stdout, 'cmd': ' '.join(cmd)})
        else:
            return jsonify({'authenticated': False, 'message': 'Nenhuma conta B2 autorizada.', 'error': result.stderr})
    except Exception as e:
        return jsonify({'authenticated': False, 'message': f'Erro ao checar conta B2: {str(e)}'})

@app.route('/api/account/authorize', methods=['POST'])
def authorize_account():
    data = request.get_json(silent=True) or {}
    key_id = data.get('key_id', '').strip()
    app_key = data.get('app_key', '').strip()
    if not key_id or not app_key:
        return jsonify({'success': False, 'message': 'Key ID e Application Key são obrigatórios.'}), 400
    try:
        cmd, result = execute_b2(['account', 'authorize', key_id, app_key], timeout=30)
        ok = result.returncode == 0
        return jsonify({
            'success': ok,
            'message': 'Conta B2 autorizada com sucesso!' if ok else 'Falha na autorização.',
            'stdout': result.stdout, 'stderr': result.stderr, 'returncode': result.returncode
        }), (200 if ok else 400)
    except Exception as e:
        return jsonify({'success': False, 'message': f'Erro: {str(e)}'}), 500

@app.route('/api/sync', methods=['POST'])
def sync_b2():
    data = request.get_json(silent=True) or {}
    local_dir = data.get('local_dir', '').strip()
    bucket = data.get('bucket', '').strip()
    try:
        threads = int(data.get('threads', 2))
    except (TypeError, ValueError):
        threads = 2

    if not local_dir:
        return jsonify({'success': False, 'message': 'Diretório local obrigatório.', 'stderr': 'local_dir vazio'}), 400
    if not bucket:
        return jsonify({'success': False, 'message': 'Bucket B2 obrigatório.', 'stderr': 'bucket vazio'}), 400
    norm = os.path.abspath(local_dir)
    if not os.path.exists(norm):
        return jsonify({'success': False, 'message': f'Pasta não existe: {norm}', 'stderr': f'{norm} não encontrada'}), 400
    try:
        # 1. Cancela preventivamente partes de uploads grandes que ficaram incompletas
        try:
            execute_b2(['file', 'large', 'unfinished', 'cancel', f'b2://{bucket}'], timeout=60)
        except Exception:
            pass

        # 2. Executa sync limitando threads (padrão 2) e com --skip-newer
        # Isso previne sobrecarga do canal de upload e quedas de conexão SSL (SSLEOFError) em arquivos de 1GB a 2GB+
        cmd_args = ['sync', '--threads', str(threads), '--skip-newer', norm, f'b2://{bucket}']
        cmd, result = execute_b2(cmd_args, timeout=7200)
        ok = result.returncode == 0
        return jsonify({
            'success': ok,
            'message': 'Sincronização concluída!' if ok else f'Código {result.returncode}.',
            'command': ' '.join(cmd), 'stdout': result.stdout or '', 'stderr': result.stderr or '',
            'returncode': result.returncode
        }), (200 if ok else 500)
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'message': 'Tempo limite excedido na sincronização (2 horas).', 'stderr': 'Timeout', 'returncode': -1}), 504
    except Exception as e:
        return jsonify({'success': False, 'message': str(e), 'stderr': str(e), 'returncode': -1}), 500

@app.route('/api/large/cancel-unfinished', methods=['POST'])
def cancel_unfinished():
    data = request.get_json(silent=True) or {}
    bucket = data.get('bucket', '').strip()
    if not bucket:
        return jsonify({'success': False, 'message': 'Bucket obrigatório.'}), 400
    try:
        cmd, result = execute_b2(['file', 'large', 'unfinished', 'cancel', f'b2://{bucket}'], timeout=120)
        ok = result.returncode == 0
        return jsonify({
            'success': ok,
            'message': 'Uploads incompletos cancelados com sucesso!' if ok else 'Falha ao cancelar uploads.',
            'stdout': result.stdout, 'stderr': result.stderr, 'returncode': result.returncode
        }), (200 if ok else 500)
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/upload', methods=['POST'])
def upload_file_b2():
    if 'file' not in request.files:
        return jsonify({'success': False, 'message': 'Nenhum arquivo enviado.'}), 400
    uploaded_file = request.files['file']
    if uploaded_file.filename == '':
        return jsonify({'success': False, 'message': 'Nome de arquivo inválido.'}), 400
    bucket = request.form.get('bucket', '').strip()
    remote_folder = request.form.get('remote_folder', '').strip()
    if not bucket:
        return jsonify({'success': False, 'message': 'Bucket B2 obrigatório.'}), 400
    filename = os.path.basename(uploaded_file.filename)
    b2_file_name = f"{remote_folder.strip('/').strip(chr(92))}/{filename}" if remote_folder else filename
    temp_dir = tempfile.mkdtemp(prefix="worship_b2_")
    temp_file_path = os.path.join(temp_dir, filename)
    try:
        uploaded_file.save(temp_file_path)
        cmd, result = execute_b2(['file', 'upload', bucket, temp_file_path, b2_file_name], timeout=1200)
        ok = result.returncode == 0
        return jsonify({
            'success': ok,
            'message': f'Upload de "{filename}" concluído!' if ok else f'Falha no upload de "{filename}".',
            'command': f'b2 file upload {bucket} <arquivo> {b2_file_name}',
            'b2_destination': f'b2://{bucket}/{b2_file_name}',
            'stdout': result.stdout or '', 'stderr': result.stderr or '', 'returncode': result.returncode
        }), (200 if ok else 500)
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'message': 'Timeout no upload.', 'stderr': 'Timeout', 'returncode': -1}), 504
    except Exception as e:
        return jsonify({'success': False, 'message': str(e), 'stderr': str(e), 'returncode': -1}), 500
    finally:
        try:
            if os.path.exists(temp_file_path): os.remove(temp_file_path)
            if os.path.exists(temp_dir): os.rmdir(temp_dir)
        except Exception: pass

# ══════════════════════════════════════════════════════════════════════════════
# Supabase: Status & Configuração
# ══════════════════════════════════════════════════════════════════════════════
@app.route('/api/supabase/status', methods=['GET'])
def supabase_status():
    global SUPABASE_SERVICE_KEY
    if not SUPABASE_SERVICE_KEY:
        return jsonify({
            'connected': False,
            'mode': 'local',
            'message': 'Modo Local Ativo. Para sincronizar diretamente com a nuvem Supabase, informe a Service Role Key.',
            'url': SUPABASE_URL
        })
    sb = get_supabase_client()
    if sb is None:
        return jsonify({
            'connected': False,
            'mode': 'local',
            'message': 'Não foi possível conectar com a chave fornecida.',
            'url': SUPABASE_URL
        })
    try:
        sb.auth.admin.list_users(page=1, per_page=1)
        return jsonify({
            'connected': True,
            'mode': 'cloud',
            'message': 'Supabase conectado com sucesso (Nuvem em tempo real).',
            'url': SUPABASE_URL
        })
    except Exception as e:
        return jsonify({
            'connected': False,
            'mode': 'local',
            'message': f'Chave inválida ou não autorizada: {str(e)[:150]}',
            'url': SUPABASE_URL
        })

@app.route('/api/supabase/configure', methods=['POST'])
def supabase_configure():
    global SUPABASE_SERVICE_KEY, _supabase_client
    data = request.get_json(silent=True) or {}
    key = data.get('service_key', '').strip()
    if not key:
        return jsonify({'success': False, 'message': 'Service Role Key é obrigatória.'}), 400
    try:
        from supabase import create_client
        test_client = create_client(SUPABASE_URL, key)
        test_client.auth.admin.list_users(page=1, per_page=1)
        SUPABASE_SERVICE_KEY = key
        _supabase_client = test_client
        return jsonify({'success': True, 'message': 'Service Role Key validada e conectada com sucesso!'})
    except Exception as e:
        return jsonify({'success': False, 'message': f'Chave inválida: {str(e)[:200]}'}), 400

# ══════════════════════════════════════════════════════════════════════════════
# Script SQL Oficial para o Supabase (Tabelas, RLS e Triggers)
# ══════════════════════════════════════════════════════════════════════════════
SUPABASE_SETUP_SQL = """-- ====================================================================
-- SCRIPT DE CONFIGURAÇÃO DO SUPABASE - WORSHIP PLAYBACK PRO
-- Execute este script no SQL Editor do seu projeto Supabase:
-- https://supabase.com/dashboard/project/ljrxnooemnfssqdlorgt/sql/new
-- ====================================================================

-- 1. TABELA DE PLANOS & ASSINATURAS
CREATE TABLE IF NOT EXISTS public.plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL, -- Valor em centavos (ex: 4990 = R$ 49,90)
  interval TEXT NOT NULL DEFAULT 'month',
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view active plans" ON public.plans;
CREATE POLICY "Anyone can view active plans" ON public.plans FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins can manage plans" ON public.plans;
CREATE POLICY "Admins can manage plans" ON public.plans FOR ALL USING (true);

-- Inserir / Atualizar os Planos no catálogo do Supabase
INSERT INTO public.plans (id, name, price, interval, description, is_active)
VALUES
    ('assinatura_app', 'Assinatura app WorshipTools mensal', 4990, 'month', 'Acesso completo ao mixer multitrack de 8 canais, pads contínuos e catálogo.', true),
    ('mensal', 'Assinatura app WorshipTools + 200GB Nuvem B2', 9990, 'month', 'Mixer completo + 200GB de armazenamento no Backblaze B2 para sincronizar sessões.', true),
    ('anual_pro', 'Plano Pro Anual (2 Meses Grátis)', 47900, 'year', 'Acesso anual ilimitado com economia de 20% e suporte prioritário.', true),
    ('church_vip', 'Ministério / Igreja VIP Anual', 99000, 'year', 'Licença para múltiplos computadores da equipe de louvor e suporte dedicado.', true),
    ('free', 'Gratuito (Teste / Visitante)', 0, 'lifetime', 'Acesso básico gratuito para testes e visualização.', true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    price = EXCLUDED.price,
    interval = EXCLUDED.interval,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active;

-- 2. TABELA DE PERFIS DE MEMBROS / CLIENTES (PROFILES)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    full_name TEXT,
    role TEXT DEFAULT 'Músico',
    status TEXT DEFAULT 'pending', -- 'pending' (pendente), 'active' (aprovado), 'blocked' (bloqueado)
    plan_id TEXT REFERENCES public.plans(id) DEFAULT 'assinatura_app',
    plan_name TEXT DEFAULT 'Assinatura app WorshipTools mensal',
    subscription_status TEXT DEFAULT 'Pendente',
    subscription_expires_at DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Garantir colunas essenciais caso a tabela já exista
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'Músico';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS plan_id TEXT DEFAULT 'assinatura_app';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS plan_name TEXT DEFAULT 'Assinatura app WorshipTools mensal';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'Pendente';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_expires_at DATE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now());
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now());

-- Habilitar RLS em profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Permitir leitura de perfis" ON public.profiles;
CREATE POLICY "Permitir leitura de perfis" ON public.profiles
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Permitir gestão de perfis" ON public.profiles;
CREATE POLICY "Permitir gestão de perfis" ON public.profiles
    FOR ALL USING (true);

-- 3. TRIGGER AUTOMÁTICO: NOVO USUÁRIO EM AUTH.USERS VAI PARA PROFILES COMO 'PENDENTE'
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
    INSERT INTO public.profiles (
        id,
        email,
        full_name,
        role,
        status,
        plan_id,
        plan_name,
        subscription_status,
        subscription_expires_at,
        created_at,
        updated_at
    )
    VALUES (
        new.id,
        new.email,
        COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
        COALESCE(new.raw_user_meta_data->>'role', 'Músico'),
        COALESCE(new.raw_user_meta_data->>'status', 'pending'),
        COALESCE(new.raw_user_meta_data->>'plan_id', 'assinatura_app'),
        COALESCE(new.raw_user_meta_data->>'plan_name', 'Assinatura app WorshipTools mensal'),
        'Pendente',
        CURRENT_DATE + INTERVAL '30 days',
        now(),
        now()
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
        updated_at = now();
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 4. SINCRONIZAR USUÁRIOS QUE JÁ EXISTEM NO AUTH.USERS
INSERT INTO public.profiles (id, email, full_name, role, status, plan_id, plan_name, subscription_status, subscription_expires_at)
SELECT 
    au.id,
    au.email,
    COALESCE(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', split_part(au.email, '@', 1)),
    COALESCE(au.raw_user_meta_data->>'role', 'Músico'),
    COALESCE(au.raw_user_meta_data->>'status', 'pending'),
    COALESCE(au.raw_user_meta_data->>'plan_id', 'assinatura_app'),
    COALESCE(au.raw_user_meta_data->>'plan_name', 'Assinatura app WorshipTools mensal'),
    'Pendente',
    CURRENT_DATE + INTERVAL '30 days'
FROM auth.users au
ON CONFLICT (id) DO NOTHING;
"""

@app.route('/api/supabase/sql', methods=['GET'])
def get_supabase_sql():
    """Retorna o script SQL completo para configuração das tabelas no Supabase."""
    return jsonify({
        'success': True,
        'sql': SUPABASE_SETUP_SQL,
        'project_url': SUPABASE_URL,
        'sql_editor_url': 'https://supabase.com/dashboard/project/ljrxnooemnfssqdlorgt/sql/new'
    })

@app.route('/api/supabase/seed-plans', methods=['POST'])
def seed_supabase_plans():
    """Tenta popular ou atualizar a tabela de planos diretamente no Supabase."""
    sb = get_supabase_client(require_service=False)
    if sb is None:
        return jsonify({'success': False, 'message': 'Supabase não conectado.'}), 400
    try:
        inserted = []
        for p in DEFAULT_PLANS:
            try:
                res = sb.table('plans').upsert({
                    'id': p['id'],
                    'name': p['name'],
                    'price': p['price'],
                    'interval': p['interval'],
                    'description': p['description'],
                    'is_active': p['is_active']
                }).execute()
                inserted.append(p['id'])
            except Exception as ex:
                print(f"Erro ao inserir plano {p['id']}:", ex)
        if inserted:
            return jsonify({
                'success': True,
                'message': f'{len(inserted)} planos configurados com sucesso no Supabase!',
                'plans': inserted
            })
        else:
            return jsonify({
                'success': False,
                'message': 'Não foi possível gravar na tabela de planos. Por favor, execute o Script SQL no Supabase.'
            }), 400
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'Erro ao gravar planos no Supabase: {str(e)[:150]}. Execute o Script SQL no console Supabase.'
        }), 400

# ══════════════════════════════════════════════════════════════════════════════
# Catálogo de Planos
# ══════════════════════════════════════════════════════════════════════════════
DEFAULT_PLANS = [
    {
        'id': 'assinatura_app',
        'name': 'Assinatura app WorshipTools mensal',
        'price': 4990,
        'interval': 'month',
        'description': 'Acesso completo ao mixer de 8 canais, pads contínuos e download de multitracks.',
        'is_active': True
    },
    {
        'id': 'mensal',
        'name': 'Assinatura app WorshipTools + 200GB Nuvem B2',
        'price': 9990,
        'interval': 'month',
        'description': 'Mixer completo + 200GB de armazenamento no Backblaze B2 para sincronizar suas sessões.',
        'is_active': True
    },
    {
        'id': 'anual_pro',
        'name': 'Plano Pro Anual (2 Meses Grátis)',
        'price': 47900,
        'interval': 'year',
        'description': 'Acesso anual ilimitado com 20% de desconto e suporte prioritário para a equipe.',
        'is_active': True
    },
    {
        'id': 'church_vip',
        'name': 'Ministério / Igreja VIP Anual',
        'price': 99000,
        'interval': 'year',
        'description': 'Ideal para ministérios com múltiplos computadores, vocalistas e equipe completa.',
        'is_active': True
    },
    {
        'id': 'free',
        'name': 'Gratuito (Teste / Visitante)',
        'price': 0,
        'interval': 'lifetime',
        'description': 'Acesso básico gratuito para testes e visualização padrão do catálogo.',
        'is_active': True
    }
]

@app.route('/api/plans', methods=['GET'])
def get_plans():
    """Retorna os planos cadastrados (banco Supabase + catálogo oficial)."""
    sb = get_supabase_client(require_service=False)
    plans_map = {p['id']: p for p in DEFAULT_PLANS}
    found_in_db = False

    if sb is not None:
        try:
            res = sb.table('plans').select('*').execute()
            if res.data and isinstance(res.data, list) and len(res.data) > 0:
                found_in_db = True
                for db_plan in res.data:
                    plans_map[db_plan['id']] = db_plan
        except Exception:
            pass

    return jsonify({
        'success': True,
        'plans': list(plans_map.values()),
        'in_database': found_in_db
    })

# ══════════════════════════════════════════════════════════════════════════════
# Gestão de Membros (Supabase Cloud + Fallback Local Resiliente)
# ══════════════════════════════════════════════════════════════════════════════
def extract_member_data(user, profiles_dict=None):
    if hasattr(user, '__dict__'):
        u = user.__dict__ if not hasattr(user, 'model_dump') else user.model_dump()
    elif isinstance(user, dict):
        u = user
    else:
        return None

    uid = str(u.get('id', ''))
    user_meta = u.get('user_metadata', {}) or {}
    app_meta = u.get('app_metadata', {}) or {}
    prof = (profiles_dict or {}).get(uid, {})

    name = (
        user_meta.get('name') or
        user_meta.get('full_name') or
        prof.get('full_name') or
        prof.get('name') or
        ''
    )

    role = (
        user_meta.get('role') or
        user_meta.get('cargo') or
        prof.get('role') or
        app_meta.get('role') or
        'Músico'
    )

    # Determinar status normalizado
    banned_until = u.get('banned_until')
    is_banned = False
    if banned_until:
        try:
            ban_dt = datetime.fromisoformat(str(banned_until).replace('Z', '+00:00'))
            is_banned = (ban_dt > datetime.now(ban_dt.tzinfo))
        except Exception:
            is_banned = True

    raw_status = str(user_meta.get('status') or prof.get('status') or '').lower().strip()

    if is_banned or raw_status in ['bloqueado', 'blocked', 'rejected']:
        status = 'Bloqueado'
    elif raw_status in ['pendente', 'pending']:
        status = 'Pendente'
    elif raw_status in ['aprovado', 'active', 'ativo'] or user_meta.get('approved') is True:
        status = 'Aprovado'
    else:
        # Se tem e-mail mas não foi aprovado explicitamente, padrão é Pendente para permitir moderação
        status = 'Pendente' if not u.get('email_confirmed_at') else 'Aprovado'

    plan_id = user_meta.get('plan_id') or prof.get('plan') or prof.get('plan_id') or 'assinatura_app'
    plan_name = user_meta.get('plan_name') or 'Worship Playback Mensal'
    sub_status = user_meta.get('subscription_status') or ('Ativa' if status == 'Aprovado' else 'Pendente')
    expires_at = user_meta.get('subscription_expires_at') or ''

    return {
        'id': uid,
        'email': u.get('email', ''),
        'phone': u.get('phone', ''),
        'name': name,
        'role': role,
        'status': status,
        'plan_id': plan_id,
        'plan_name': plan_name,
        'subscription_status': sub_status,
        'subscription_expires_at': str(expires_at),
        'created_at': str(u.get('created_at', '')),
        'last_sign_in_at': str(u.get('last_sign_in_at', '')),
        'is_banned': is_banned
    }

@app.route('/api/users', methods=['GET'])
def list_users():
    """Lista todos os membros reais cadastrados no Supabase (Auth + Profiles)."""
    sb_admin = get_supabase_client(require_service=True)
    sb = get_supabase_client(require_service=False)

    users_list = []
    seen_ids = set()

    # 1. Puxar do Supabase Auth Admin (quando Service Role Key estiver configurada)
    if sb_admin is not None:
        try:
            profiles_map = {}
            try:
                p_res = sb_admin.table('profiles').select('*').execute()
                if p_res.data:
                    for p in p_res.data:
                        profiles_map[str(p.get('id'))] = p
            except Exception:
                pass

            response = sb_admin.auth.admin.list_users(page=1, per_page=100)
            users_data = response if isinstance(response, list) else getattr(response, 'users', response)
            if not isinstance(users_data, list):
                users_data = list(users_data) if hasattr(users_data, '__iter__') else []

            for u in users_data:
                item = extract_member_data(u, profiles_map)
                if item and item['id'] not in seen_ids:
                    seen_ids.add(item['id'])
                    users_list.append(item)
        except Exception as e:
            print("Aviso ao ler auth.admin:", e)

    # 2. Consultar tabela profiles diretamente no Supabase (funciona tanto com Anon Key quanto Service Key)
    if sb is not None:
        try:
            p_res = sb.table('profiles').select('*').execute()
            if p_res.data and isinstance(p_res.data, list):
                for p in p_res.data:
                    pid = str(p.get('id', ''))
                    if pid and pid not in seen_ids:
                        seen_ids.add(pid)
                        st_raw = str(p.get('status', 'pending')).lower()
                        if st_raw in ['blocked', 'bloqueado', 'banned']:
                            st = 'Bloqueado'
                        elif st_raw in ['pending', 'pendente']:
                            st = 'Pendente'
                        else:
                            st = 'Aprovado'

                        p_id = p.get('plan_id') or p.get('plan') or 'assinatura_app'
                        p_name = p.get('plan_name') or 'Assinatura app WorshipTools mensal'

                        users_list.append({
                            'id': pid,
                            'email': p.get('email', ''),
                            'phone': p.get('phone', ''),
                            'name': p.get('full_name') or p.get('name') or (p.get('email', '').split('@')[0] if p.get('email') else 'Membro'),
                            'role': p.get('role', 'Músico'),
                            'status': st,
                            'plan_id': p_id,
                            'plan_name': p_name,
                            'subscription_status': p.get('subscription_status', 'Ativa' if st == 'Aprovado' else 'Pendente'),
                            'subscription_expires_at': str(p.get('subscription_expires_at') or ''),
                            'created_at': str(p.get('created_at') or ''),
                            'last_sign_in_at': str(p.get('last_sign_in_at') or ''),
                            'is_banned': (st == 'Bloqueado')
                        })
        except Exception as e:
            print("Aviso ao consultar profiles:", e)

    # 3. Adicionar membros locais criados nesta sessão que ainda não subiram
    local_members = load_local_members()
    for lm in local_members:
        if lm.get('id') and lm['id'] not in seen_ids:
            seen_ids.add(lm['id'])
            users_list.append(lm)

    return jsonify({
        'success': True,
        'users': users_list,
        'count': len(users_list),
        'source': 'supabase' if (sb_admin or sb) else 'empty'
    })

@app.route('/api/users', methods=['POST'])
def create_user():
    """Cria um novo membro com plano e status de aprovação inicial."""
    data = request.get_json(silent=True) or {}
    email = data.get('email', '').strip()
    password = data.get('password', '').strip()
    name = data.get('name', '').strip()
    role = data.get('role', 'Músico').strip()
    plan_id = data.get('plan_id', 'assinatura_app').strip()
    plan_name = data.get('plan_name', 'Worship Playback Mensal').strip()
    initial_status = data.get('status', 'Aprovado').strip()

    if not email:
        return jsonify({'success': False, 'message': 'E-mail é obrigatório.'}), 400
    if not password or len(password) < 6:
        return jsonify({'success': False, 'message': 'Senha deve ter no mínimo 6 caracteres.'}), 400

    expires_date = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
    new_id = f"mem_{int(datetime.now().timestamp())}"

    # Salva localmente sempre para garantir consistência
    local_members = load_local_members()
    new_member_record = {
        'id': new_id,
        'email': email,
        'name': name or email.split('@')[0],
        'role': role,
        'status': initial_status,
        'plan_id': plan_id,
        'plan_name': plan_name,
        'subscription_status': 'Ativa' if initial_status == 'Aprovado' else 'Pendente',
        'subscription_expires_at': expires_date,
        'created_at': datetime.now().isoformat(),
        'last_sign_in_at': '',
        'is_banned': False
    }

    # Tenta salvar no Supabase se disponível
    sb = get_supabase_client()
    if sb is not None:
        try:
            response = sb.auth.admin.create_user({
                'email': email,
                'password': password,
                'email_confirm': True,
                'user_metadata': {
                    'name': name,
                    'full_name': name,
                    'role': role,
                    'status': initial_status,
                    'approved': (initial_status == 'Aprovado'),
                    'plan_id': plan_id,
                    'plan_name': plan_name,
                    'subscription_status': 'Ativa' if initial_status == 'Aprovado' else 'Pendente',
                    'subscription_expires_at': expires_date
                }
            })
            new_user = getattr(response, 'user', response)
            uid = str(getattr(new_user, 'id', '') or (new_user.get('id', '') if isinstance(new_user, dict) else ''))
            if uid:
                new_member_record['id'] = uid
                try:
                    sb.table('profiles').upsert({
                        'id': uid,
                        'full_name': name,
                        'email': email,
                        'role': role,
                        'status': 'active' if initial_status == 'Aprovado' else 'pending'
                    }).execute()
                except Exception:
                    pass
        except Exception as e:
            print("Aviso ao sincronizar no Supabase Cloud:", e)

    # Inserir no topo da lista local
    local_members.insert(0, new_member_record)
    save_local_members(local_members)

    return jsonify({
        'success': True,
        'message': f'Membro "{email}" adicionado com sucesso ({initial_status})!',
        'user': new_member_record
    })

@app.route('/api/users/<user_id>/approve', methods=['POST'])
def approve_user(user_id):
    """Aprova um membro pendente e libera o acesso ao aplicativo."""
    # Atualiza localmente
    local_members = load_local_members()
    for m in local_members:
        if m['id'] == user_id:
            m['status'] = 'Aprovado'
            m['is_banned'] = False
            if m.get('subscription_status') in ['Pendente', 'Bloqueada']:
                m['subscription_status'] = 'Ativa'
            break
    save_local_members(local_members)

    # 1. Atualiza na tabela profiles do Supabase
    sb = get_supabase_client(require_service=False)
    if sb is not None:
        try:
            sb.table('profiles').update({
                'status': 'active',
                'subscription_status': 'Ativa'
            }).eq('id', user_id).execute()
        except Exception as e:
            print("Aviso aprovação na tabela profiles:", e)

    # 2. Atualiza no Supabase Auth Admin se Service Role Key estiver configurada
    sb_admin = get_supabase_client(require_service=True)
    if sb_admin is not None:
        try:
            curr_user = sb_admin.auth.admin.get_user_by_id(user_id)
            meta = getattr(curr_user, 'user_metadata', {}) or {}
            if hasattr(curr_user, 'user'):
                meta = getattr(curr_user.user, 'user_metadata', meta) or {}
            meta['status'] = 'Aprovado'
            meta['approved'] = True
            if meta.get('subscription_status') in ['Pendente', 'Bloqueada']:
                meta['subscription_status'] = 'Ativa'

            sb_admin.auth.admin.update_user_by_id(user_id, {
                'user_metadata': meta,
                'ban_duration': 'none'
            })
        except Exception as e:
            print("Aviso aprovação no Supabase Auth Admin:", e)

    return jsonify({
        'success': True,
        'message': 'Membro APROVADO com sucesso! Acesso liberado ao app.'
    })

@app.route('/api/users/<user_id>/block', methods=['POST'])
def block_user(user_id):
    """Bloqueia/suspende o acesso do membro."""
    local_members = load_local_members()
    for m in local_members:
        if m['id'] == user_id:
            m['status'] = 'Bloqueado'
            m['is_banned'] = True
            m['subscription_status'] = 'Bloqueada'
            break
    save_local_members(local_members)

    sb = get_supabase_client(require_service=False)
    if sb is not None:
        try:
            sb.table('profiles').update({
                'status': 'blocked',
                'subscription_status': 'Bloqueada'
            }).eq('id', user_id).execute()
        except Exception as e:
            print("Aviso bloqueio na tabela profiles:", e)

    sb_admin = get_supabase_client(require_service=True)
    if sb_admin is not None:
        try:
            curr_user = sb_admin.auth.admin.get_user_by_id(user_id)
            meta = getattr(curr_user, 'user_metadata', {}) or {}
            if hasattr(curr_user, 'user'):
                meta = getattr(curr_user.user, 'user_metadata', meta) or {}
            meta['status'] = 'Bloqueado'
            meta['approved'] = False
            meta['subscription_status'] = 'Bloqueada'

            sb_admin.auth.admin.update_user_by_id(user_id, {
                'user_metadata': meta,
                'ban_duration': '876600h'
            })
        except Exception as e:
            print("Aviso bloqueio no Supabase Auth Admin:", e)

    return jsonify({
        'success': True,
        'message': 'Membro BLOQUEADO! O acesso ao aplicativo foi revogado.'
    })

@app.route('/api/users/<user_id>/unblock', methods=['POST'])
def unblock_user(user_id):
    """Desbloqueia um membro previamente suspenso."""
    local_members = load_local_members()
    for m in local_members:
        if m['id'] == user_id:
            m['status'] = 'Aprovado'
            m['is_banned'] = False
            m['subscription_status'] = 'Ativa'
            break
    save_local_members(local_members)

    sb = get_supabase_client(require_service=False)
    if sb is not None:
        try:
            sb.table('profiles').update({
                'status': 'active',
                'subscription_status': 'Ativa'
            }).eq('id', user_id).execute()
        except Exception as e:
            print("Aviso desbloqueio na tabela profiles:", e)

    sb_admin = get_supabase_client(require_service=True)
    if sb_admin is not None:
        try:
            curr_user = sb_admin.auth.admin.get_user_by_id(user_id)
            meta = getattr(curr_user, 'user_metadata', {}) or {}
            if hasattr(curr_user, 'user'):
                meta = getattr(curr_user.user, 'user_metadata', meta) or {}
            meta['status'] = 'Aprovado'
            meta['approved'] = True
            meta['subscription_status'] = 'Ativa'

            sb_admin.auth.admin.update_user_by_id(user_id, {
                'user_metadata': meta,
                'ban_duration': 'none'
            })
        except Exception as e:
            print("Aviso desbloqueio no Supabase Auth Admin:", e)

    return jsonify({
        'success': True,
        'message': 'Membro DESBLOQUEADO com sucesso!'
    })

@app.route('/api/users/<user_id>/subscription', methods=['PUT'])
def update_user_subscription(user_id):
    """Atualiza o plano, status da assinatura e validade do membro."""
    data = request.get_json(silent=True) or {}
    plan_id = data.get('plan_id', '').strip()
    plan_name = data.get('plan_name', '').strip()
    sub_status = data.get('subscription_status', 'Ativa').strip()
    expires_at = data.get('expires_at', '').strip()

    # Atualiza localmente
    local_members = load_local_members()
    for m in local_members:
        if m['id'] == user_id:
            if plan_id: m['plan_id'] = plan_id
            if plan_name: m['plan_name'] = plan_name
            if sub_status: m['subscription_status'] = sub_status
            if expires_at: m['subscription_expires_at'] = expires_at
            break
    save_local_members(local_members)

    sb = get_supabase_client(require_service=False)
    if sb is not None:
        try:
            up_dict = {}
            if plan_id:
                up_dict['plan_id'] = plan_id
                up_dict['plan'] = plan_id
            if plan_name: up_dict['plan_name'] = plan_name
            if sub_status: up_dict['subscription_status'] = sub_status
            if expires_at: up_dict['subscription_expires_at'] = expires_at
            if up_dict:
                sb.table('profiles').update(up_dict).eq('id', user_id).execute()
        except Exception as e:
            print("Aviso assinatura na tabela profiles:", e)

    sb_admin = get_supabase_client(require_service=True)
    if sb_admin is not None:
        try:
            curr_user = sb_admin.auth.admin.get_user_by_id(user_id)
            meta = getattr(curr_user, 'user_metadata', {}) or {}
            if hasattr(curr_user, 'user'):
                meta = getattr(curr_user.user, 'user_metadata', meta) or {}
            if plan_id: meta['plan_id'] = plan_id
            if plan_name: meta['plan_name'] = plan_name
            if sub_status: meta['subscription_status'] = sub_status
            if expires_at: meta['subscription_expires_at'] = expires_at

            sb_admin.auth.admin.update_user_by_id(user_id, {'user_metadata': meta})
        except Exception as e:
            print("Aviso assinatura no Supabase Auth Admin:", e)

    return jsonify({
        'success': True,
        'message': f'Plano atualizado com sucesso ({plan_name} - {sub_status})!'
    })

    return jsonify({
        'success': True,
        'message': f'Plano atualizado com sucesso ({plan_name} - {sub_status})!'
    })

@app.route('/api/users/<user_id>', methods=['PUT'])
def update_user(user_id):
    data = request.get_json(silent=True) or {}
    name = data.get('name', '').strip()
    role = data.get('role', '').strip()

    local_members = load_local_members()
    for m in local_members:
        if m['id'] == user_id:
            if name: m['name'] = name
            if role: m['role'] = role
            break
    save_local_members(local_members)

    sb = get_supabase_client()
    if sb is not None:
        try:
            curr_user = sb.auth.admin.get_user_by_id(user_id)
            meta = getattr(curr_user, 'user_metadata', {}) or {}
            if hasattr(curr_user, 'user'):
                meta = getattr(curr_user.user, 'user_metadata', meta) or {}
            if name: meta['name'] = name; meta['full_name'] = name
            if role: meta['role'] = role; meta['cargo'] = role
            sb.auth.admin.update_user_by_id(user_id, {'user_metadata': meta})
            try:
                sb.table('profiles').update({'full_name': name, 'role': role}).eq('id', user_id).execute()
            except Exception:
                pass
        except Exception as e:
            print("Aviso atualizar perfil no Supabase:", e)

    return jsonify({'success': True, 'message': 'Dados do membro atualizados!'})

@app.route('/api/users/<user_id>', methods=['DELETE'])
def delete_user(user_id):
    local_members = load_local_members()
    local_members = [m for m in local_members if m['id'] != user_id]
    save_local_members(local_members)

    sb = get_supabase_client()
    if sb is not None:
        try:
            try:
                sb.table('profiles').delete().eq('id', user_id).execute()
            except Exception:
                pass
            sb.auth.admin.delete_user(user_id)
        except Exception as e:
            print("Aviso delete no Supabase:", e)

    return jsonify({'success': True, 'message': 'Membro removido do sistema com sucesso.'})

# ══════════════════════════════════════════════════════════════════════════════
# Inicialização
# ══════════════════════════════════════════════════════════════════════════════
def open_browser():
    webbrowser.open_new("http://127.0.0.1:5000")

if __name__ == '__main__':
    print("=" * 65)
    print("  WORSHIP PLAYBACK PRO - B2 SYNC & GESTÃO COMPLETA DE MEMBROS")
    print("  (Aprovação, Bloqueio, Planos e Assinaturas)")
    print("  Iniciando servidor local em http://127.0.0.1:5000")
    print("  O navegador será aberto automaticamente...")
    print("=" * 65)
    threading.Timer(1.2, open_browser).start()
    app.run(host='127.0.0.1', port=5000, debug=False)
