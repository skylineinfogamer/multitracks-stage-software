# Worship Tools — Changelog

Todas as alterações notáveis deste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

---

## [1.0.4] - 2026-11-01

### 🚀 Novidades Principais
- ☁️ **Nuvem Dedicada por Usuário** — 500 GB de armazenamento isolado no Backblaze B2 para cada assinante Pro Cloud, com pasta exclusiva e zero mistura de arquivos.
- 🎵 **Setlist Sincronizada com Painel do Músico** — Crie e edite repertórios no painel web e sincronize instantaneamente no app desktop (um clique via Wi-Fi).
- 💾 **Cache Local Inteligente de Multitracks** — Downloads repetidos agora usam o cache do PC (0 KB de tráfego B2, economia real de custos operacionais).

### ⚡ Performance & Estabilidade
- Interface mais fluida: renderização otimizada, menos re-renders, zero engasgos em setlists longas.
- Motor de áudio ASIO/WASAPI refinado — latência consistente, sem cracks nem drops de áudio.
- Auto-Updater robusto: verificação de integridade digital, download resumível, fallback automático.
- Correção de vazamento de memória em sessões prolongadas (>4h de uso contínuo).

### 🔧 Correções & Polimento
- **Admin Web**: proteção de rota `/admin/` com validação JWT + `role=admin` (fim de bypass por URL direta).
- **CORS**: wildcard `*` removido em produção — origem explícita apenas (`https://worshiptools-28vv4k.cubehost.dev`).
- **Mobile**: header responsivo corrigido (logo + botão sem sobreposição em telas pequenas).
- **Copy do Landing**: "Backblaze B2" → "Nuvem ultra rápida em servidores dedicados" (linguagem voltada a conversão).

### 🛡️ Segurança
- Rotação **obrigatória** de todas as credenciais previamente expostas (Supabase Service Role Key, B2 Application Key, senhas de admin).
- Rate limiting reforçado em endpoints sensíveis (`/api/auth/login`, `/api/upload`, `/api/b2/*`).

### 🏷️ Assinatura
- "Desenvolvido por Leandro Machado" presente no rodapé de todas as telas (Web: Landing, Login, Admin, Perfil, Sidebar; Desktop: SettingsDialog).

---

## [1.0.3] - 2026-10-31

### Adicionado
- Sistema de auto-atualização via GitHub Releases (Tauri v2 Updater).
- Assinatura digital dos instaladores NSIS (minisign/tauri-signer).
- Pipeline de release automatizado (`npm run release`).

### Corrigido
- Sincronização de playlists web → desktop.
- Importação de multitracks ZIP (VS/Multitrack).
- Renderização de waveform no editor.

---

## [1.0.0] - 2026-10-01

### Lançamento Inicial
- App desktop Tauri + React (Windows/macOS).
- Mixer multipista 8 canais (solo, mute, pan, volume, roteamento OUT 1-6).
- Click & Guia Neural IA (pacotes de voz pt-BR).
- Studio Pitch Pro (SOLA + Drum Bypass, formantes, 432/440Hz).
- Setlists com transições (STOP, AUTO_ADVANCE, OVERLAP, CROSSFADE).
- Controle remoto via Wi-Fi (iPad/Android) — QR Code + WebSocket.
- MIDI In/Out (cues ProPresenter, DMX, automação).
- Painel Web (React + Node.js/Express) — Dashboard, Upload B2, Playlists, Admin.
- SaaS multi-tenant: planos, assinaturas, perfis, roles (admin/client).
- Backblaze B2 integration (presigned URLs, upload direto do navegador).

---

[1.0.4]: https://github.com/skylineinfogamer/multitracks-stage-software/releases/tag/v1.0.4
[1.0.3]: https://github.com/skylineinfogamer/multitracks-stage-software/releases/tag/v1.0.3
[1.0.0]: https://github.com/skylineinfogamer/multitracks-stage-software/releases/tag/v1.0.0