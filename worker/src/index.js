import { DurableObject } from 'cloudflare:workers';

const SHEET_ENDPOINT = 'https://script.google.com/macros/s/AKfycbx7OgYnA0OKPgXL9yhWUhdxCz4C7UnapjXWYaSukelqt6u__2wOs1eVZvpetmKmil59/exec';
const ADMIN_COOKIE_NAME = '__Host-rd_admin';
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const textEncoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function timingSafeEqualBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function timingSafeEqualText(left, right) {
  return timingSafeEqualBytes(textEncoder.encode(left), textEncoder.encode(right));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getSessionKey(env) {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signSessionPayload(payload, env) {
  const key = await getSessionKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

function randomBase64Url(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function createAdminSession(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS;
  const payload = `v1.${expiresAt}.${randomBase64Url()}`;
  const signature = await signSessionPayload(payload, env);
  return `${payload}.${signature}`;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const entry of cookieHeader.split(';')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = entry.slice(0, separatorIndex).trim();
    if (key === name) return entry.slice(separatorIndex + 1).trim();
  }
  return null;
}

function hasAdminSecrets(env) {
  return typeof env.ADMIN_PASSWORD_HASH === 'string'
    && /^[a-f0-9]{64}$/i.test(env.ADMIN_PASSWORD_HASH)
    && typeof env.SESSION_SECRET === 'string'
    && env.SESSION_SECRET.length >= 32;
}

async function isAdminAuthenticated(request, env) {
  if (!hasAdminSecrets(env)) return false;
  const token = getCookie(request, ADMIN_COOKIE_NAME);
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;

  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;

  const payload = parts.slice(0, 3).join('.');
  const expectedSignature = await signSessionPayload(payload, env);

  try {
    return timingSafeEqualBytes(
      base64UrlToBytes(parts[3]),
      base64UrlToBytes(expectedSignature)
    );
  } catch (_) {
    return false;
  }
}

function adminCookie(value, maxAge = ADMIN_SESSION_TTL_SECONDS) {
  return `${ADMIN_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function securityHeaders(contentType = null) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

function unauthorizedJson() {
  return Response.json(
    { success: false, error: 'Autenticação administrativa necessária.' },
    { status: 401, headers: securityHeaders() }
  );
}

// ========================================================
// 0. CONFIGURAÇÃO REMOTA DE SELETORES DO DOM (DINÂMICO)
// Se o Google mudar o DOM amanhã, basta alterar aqui e dar wrangler deploy!
// 100% das extensões instaladas atualizam no mesmo instante sem reinstalação.
// ========================================================
export const DOM_RULES = {
  version: '1.2.1',
  targetUrl: 'https://remotedesktop.google.com/support',
  generateSelectors: [
    '[aria-label="Gerar código"]',
    '[aria-label="Gerar codigo"]',
    '[aria-label="Generate code"]',
    '[aria-label*="Gerar c"]',
    '[aria-label*="Generate code"]'
  ],
  buttonTextKeywords: [
    'gerar código',
    'gerar codigo',
    '+ gerar código',
    '+ gerar codigo',
    'generate code',
    '+ generate code'
  ],
  containerLabels: [
    'Compartilhar esta tela',
    'Share this screen'
  ],
  copySelectors: [
    '[aria-label*="Copiar c"]',
    '[aria-label*="Copy access code"]',
    '[aria-label*="Copiar"]',
    '[aria-label*="Copy"]'
  ],
  cancelSelectors: [
    '[aria-label*="Cancelar"]',
    '[aria-label*="Cancel"]'
  ],
  codeRegex: '(\\d{4})[\\s\\u00a0-]?(\\d{4})[\\s\\u00a0-]?(\\d{4})',
  maxWaitMs: 20000,
  pollIntervalMs: 400
};

// ==========================================
// 1. DURABLE OBJECT: Central Hub de WebSockets
// ==========================================
export class RemoteDesktopHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // Map de userId -> { socket, connectedAt, lastSeen }
    this.extensionClients = new Map();
    // Set de WebSockets do Dashboard Web
    this.dashboardClients = new Set();
    // Histórico em memória dos últimos códigos gerados
    this.history = [];
    // Comandos pendentes aguardando resposta { resolve, timer }
    this.pendingCommands = new Map();
  }

  // Envia atualização da lista de usuários para todos os dashboards conectados
  broadcastUsersList() {
    const users = Array.from(this.extensionClients.entries()).map(([userId, info]) => ({
      userId,
      connectedAt: info.connectedAt,
      lastSeen: info.lastSeen
    }));

    const message = JSON.stringify({
      type: 'USERS_UPDATE',
      users
    });

    for (const socket of this.dashboardClients) {
      try {
        socket.send(message);
      } catch (_) {
        this.dashboardClients.delete(socket);
      }
    }
  }

  // Notifica todos os dashboards sobre um evento (ex: status, código gerado)
  broadcastToDashboards(data) {
    const message = JSON.stringify(data);
    for (const socket of this.dashboardClients) {
      try {
        socket.send(message);
      } catch (_) {
        this.dashboardClients.delete(socket);
      }
    }
  }

  // Salva no Google Sheets (Google Drive) via Apps Script
  async logToGoogleSheet(user, code) {
    try {
      await fetch(SHEET_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          user: user,
          code: code,
          source: 'CloudflareWorkerHub'
        })
      });
    } catch (err) {
      console.error('[DO] Falha ao enviar para Google Sheets:', err);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Endpoint de WebSocket: /ws
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const type = url.searchParams.get('type'); // 'extension' ou 'dashboard'
      if (type !== 'extension' && type !== 'dashboard') {
        return new Response('Tipo de cliente WebSocket inválido.', { status: 400 });
      }

      if (type === 'dashboard') {
        const expectedOrigin = `${url.protocol === 'http:' ? 'http:' : 'https:'}//${url.host}`;
        const sameOrigin = request.headers.get('Origin') === expectedOrigin;
        if (!sameOrigin || !(await isAdminAuthenticated(request, this.env))) {
          return new Response('Autenticação administrativa necessária.', { status: 401 });
        }
      }

      const userId = (url.searchParams.get('userId') || url.searchParams.get('client') || 'Anonimo').trim();

      const pair = new WebSocketPair();
      const [clientSocket, serverSocket] = Object.values(pair);

      serverSocket.accept();

      if (type === 'extension') {
        // Conexão vinda de uma extensão Chrome
        // Fecha conexão anterior se o mesmo userId reconectar
        const existing = this.extensionClients.get(userId);
        if (existing) {
          try { existing.socket.close(4001, 'Reconectado em nova sessão'); } catch (_) {}
        }

        const clientInfo = {
          socket: serverSocket,
          connectedAt: new Date().toISOString(),
          lastSeen: Date.now()
        };
        this.extensionClients.set(userId, clientInfo);

        // Notifica o painel sobre a nova máquina online
        this.broadcastUsersList();
        this.broadcastToDashboards({
          type: 'LOG',
          message: `Computador "${userId}" acabou de se conectar! 🟢`
        });

        // Configura ouvintes da extensão
        serverSocket.addEventListener('message', async (event) => {
          clientInfo.lastSeen = Date.now();
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'PONG') return;

            // Resposta de comando da extensão (ex: código gerado)
            if (data.type === 'COMMAND_RESULT') {
              const pending = this.pendingCommands.get(data.reqId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingCommands.delete(data.reqId);
                pending.resolve(data);
              }

              // Se gerou código com sucesso, registra no histórico e no Google Sheets
              if (data.action === 'GENERATE_CODE' && data.success && data.code) {
                const record = {
                  user: userId,
                  code: data.code,
                  timestamp: new Date().toISOString()
                };
                this.history.unshift(record);
                if (this.history.length > 30) this.history.pop();

                // Grava no Google Sheets (Google Drive)
                this.logToGoogleSheet(userId, data.code);
              }

              // Notifica os dashboards
              this.broadcastToDashboards({
                type: 'COMMAND_RESULT',
                userId,
                ...data
              });
            }

            // Notificação de progresso da extensão
            if (data.type === 'STATUS_UPDATE') {
              this.broadcastToDashboards({
                type: 'STATUS_UPDATE',
                userId,
                message: data.message,
                isError: data.isError
              });
            }
          } catch (e) {
            console.error('[DO] Erro ao processar mensagem da extensão:', e);
          }
        });

        serverSocket.addEventListener('close', () => {
          if (this.extensionClients.get(userId)?.socket === serverSocket) {
            this.extensionClients.delete(userId);
            this.broadcastUsersList();
            this.broadcastToDashboards({
              type: 'LOG',
              message: `Computador "${userId}" desconectou. 🔴`
            });
          }
        });

        return new Response(null, { status: 101, webSocket: clientSocket });

      } else {
        // Conexão vinda do Dashboard Web
        this.dashboardClients.add(serverSocket);

        // Envia estado inicial completo ao painel
        const initialUsers = Array.from(this.extensionClients.entries()).map(([u, info]) => ({
          userId: u,
          connectedAt: info.connectedAt,
          lastSeen: info.lastSeen
        }));

        serverSocket.send(JSON.stringify({
          type: 'INIT',
          users: initialUsers,
          history: this.history
        }));

        serverSocket.addEventListener('message', async (event) => {
          try {
            const data = JSON.parse(event.data);

            // Dashboard disparou comando para uma extensão específica
            if (data.action === 'SEND_COMMAND') {
              const { targetUser, command } = data;
              if (!['GENERATE_CODE', 'CLOSE_TAB'].includes(command)) {
                serverSocket.send(JSON.stringify({
                  type: 'COMMAND_RESULT',
                  success: false,
                  error: 'Comando administrativo inválido.'
                }));
                return;
              }

              const target = this.extensionClients.get(targetUser);

              if (!target) {
                serverSocket.send(JSON.stringify({
                  type: 'COMMAND_RESULT',
                  success: false,
                  error: `O computador "${targetUser}" não está conectado.`
                }));
                return;
              }

              const reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

              // Encaminha comando para a extensão via WebSocket junto com as regras dinâmicas do DOM
              target.socket.send(JSON.stringify({
                reqId,
                action: command, // 'GENERATE_CODE' ou 'CLOSE_TAB'
                domRules: command === 'GENERATE_CODE' ? DOM_RULES : undefined
              }));

              this.broadcastToDashboards({
                type: 'STATUS_UPDATE',
                userId: targetUser,
                message: command === 'GENERATE_CODE'
                  ? `Comando enviado para "${targetUser}". Aguardando código...`
                  : `Solicitando fechamento da aba no computador "${targetUser}"...`
              });
            }
          } catch (e) {
            console.error('[DO] Erro ao processar mensagem do dashboard:', e);
          }
        });

        serverSocket.addEventListener('close', () => {
          this.dashboardClients.delete(serverSocket);
        });

        return new Response(null, { status: 101, webSocket: clientSocket });
      }
    }

    // API de regras dinâmicas do DOM (permite que qualquer extensão consulte as regras mais recentes)
    if (url.pathname === '/api/dom-rules') {
      return Response.json(DOM_RULES, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    // API de status em JSON
    if (url.pathname === '/api/status') {
      if (!(await isAdminAuthenticated(request, this.env))) {
        return unauthorizedJson();
      }
      return Response.json({
        onlineUsersCount: this.extensionClients.size,
        users: Array.from(this.extensionClients.keys()),
        history: this.history
      }, { headers: securityHeaders() });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// ==========================================
// 2. WORKER HTTP HANDLER: Serve Painel Web e Roteia WS
// ==========================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/admin/login' && request.method === 'POST') {
      if (!hasAdminSecrets(env)) {
        return new Response(loginHtml('A autenticação ainda não foi configurada no Worker.'), {
          status: 503,
          headers: securityHeaders('text/html; charset=utf-8')
        });
      }

      const formData = await request.formData();
      const password = String(formData.get('password') || '');
      const passwordHash = await sha256Hex(password);

      if (!timingSafeEqualText(passwordHash.toLowerCase(), env.ADMIN_PASSWORD_HASH.toLowerCase())) {
        return new Response(loginHtml('Senha incorreta.'), {
          status: 401,
          headers: securityHeaders('text/html; charset=utf-8')
        });
      }

      const session = await createAdminSession(env);
      const headers = securityHeaders();
      headers.set('Location', '/');
      headers.append('Set-Cookie', adminCookie(session));
      return new Response(null, { status: 303, headers });
    }

    if (url.pathname === '/admin/logout' && request.method === 'POST') {
      const headers = securityHeaders();
      headers.set('Location', '/');
      headers.append('Set-Cookie', adminCookie('', 0));
      return new Response(null, { status: 303, headers });
    }

    if (url.pathname === '/admin/login' && request.method === 'GET') {
      const headers = securityHeaders();
      headers.set('Location', '/');
      return new Response(null, { status: 303, headers });
    }

    // Endpoint direto para regras dinâmicas do DOM (resposta ultra-rápida na borda)
    if (url.pathname === '/api/dom-rules') {
      return Response.json(DOM_RULES, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    // Proteção na borda: impede que uma instância antiga do Durable Object
    // ainda ativa por WebSocket receba tráfego administrativo sem autenticação.
    if (url.pathname === '/api/status' && !(await isAdminAuthenticated(request, env))) {
      return unauthorizedJson();
    }

    if (url.pathname === '/ws'
      && request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
      && url.searchParams.get('type') === 'dashboard') {
      const expectedOrigin = `${url.protocol === 'http:' ? 'http:' : 'https:'}//${url.host}`;
      const sameOrigin = request.headers.get('Origin') === expectedOrigin;
      if (!sameOrigin || !(await isAdminAuthenticated(request, env))) {
        return new Response('Autenticação administrativa necessária.', {
          status: 401,
          headers: securityHeaders('text/plain; charset=utf-8')
        });
      }
    }

    // Roteia conexões WebSocket e endpoints da API para o Durable Object único
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      const id = env.REMOTE_DESKTOP_HUB.idFromName('global-hub');
      const hub = env.REMOTE_DESKTOP_HUB.get(id);
      return hub.fetch(request);
    }

    // Serve a Interface Web do Dashboard Central
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!(await isAdminAuthenticated(request, env))) {
        return new Response(loginHtml(), {
          status: 200,
          headers: securityHeaders('text/html; charset=utf-8')
        });
      }

      return new Response(dashboardHtml, {
        headers: securityHeaders('text/html; charset=utf-8')
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

function loginHtml(errorMessage = '') {
  const errorBlock = errorMessage
    ? `<div class="error" role="alert">${errorMessage}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Acesso administrativo</title>
  <style>
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      display: grid;
      place-items: center;
      background: #0b0f19;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    main {
      width: min(100%, 420px);
      padding: 28px;
      border: 1px solid #1e293b;
      border-radius: 14px;
      background: #121826;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
    }
    h1 { margin: 0 0 8px; color: #f8fafc; font-size: 22px; }
    p { margin: 0 0 22px; color: #94a3b8; font-size: 14px; line-height: 1.5; }
    label { display: block; margin-bottom: 8px; color: #cbd5e1; font-size: 13px; font-weight: 700; }
    input {
      width: 100%;
      padding: 13px 14px;
      border: 1px solid #334155;
      border-radius: 8px;
      outline: none;
      background: #0f172a;
      color: #f8fafc;
      font-size: 16px;
    }
    input:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.12); }
    button {
      width: 100%;
      margin-top: 14px;
      padding: 13px 16px;
      border: 0;
      border-radius: 8px;
      background: #0284c7;
      color: #fff;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { background: #0369a1; }
    .error {
      margin-bottom: 14px;
      padding: 10px 12px;
      border: 1px solid rgba(248, 113, 113, 0.35);
      border-radius: 8px;
      background: rgba(239, 68, 68, 0.12);
      color: #fca5a5;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Central Remote Desktop</h1>
    <p>Digite a senha administrativa para acessar computadores e códigos.</p>
    ${errorBlock}
    <form method="post" action="/admin/login">
      <label for="password">Senha administrativa</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`;
}

// ==========================================
// 3. INTERFACE WEB: Dashboard com Dropdown e Botões
// ==========================================
const dashboardHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Central Remote Desktop Hub</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body {
      background: #0b0f19;
      color: #e2e8f0;
      padding: 24px 16px;
      display: flex;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      width: 100%;
      max-width: 580px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: #121826;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 14px;
      margin-bottom: 16px;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-title svg {
      width: 24px;
      height: 24px;
      fill: #38bdf8;
    }
    .header-title h1 {
      font-size: 17px;
      font-weight: 700;
      color: #f8fafc;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .logout-form { margin: 0; }
    .logout-button {
      padding: 5px 9px;
      border: 1px solid #334155;
      border-radius: 7px;
      background: transparent;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
    .logout-button:hover {
      border-color: #64748b;
      color: #e2e8f0;
    }
    .status-pill {
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .status-pill.online {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .status-pill.offline {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }
    label {
      font-size: 13px;
      font-weight: 600;
      color: #94a3b8;
    }
    select {
      width: 100%;
      padding: 12px 14px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f8fafc;
      font-size: 14px;
      font-weight: 500;
      outline: none;
      transition: border-color 0.2s;
    }
    select:focus {
      border-color: #38bdf8;
    }
    .btn-group {
      display: flex;
      gap: 10px;
      margin-bottom: 14px;
    }
    .btn {
      flex: 1;
      padding: 12px 16px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s ease;
    }
    .btn-primary {
      background: #0284c7;
      color: #ffffff;
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.35);
    }
    .btn-primary:hover:not(:disabled) {
      background: #0369a1;
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .btn-danger:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    .btn:disabled {
      background: #1e293b !important;
      color: #64748b !important;
      border-color: transparent !important;
      cursor: not-allowed;
      box-shadow: none;
    }
    .code-box {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 18px;
      text-align: center;
      min-height: 80px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .code-display {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 3px;
      color: #38bdf8;
      font-family: 'Consolas', 'Courier New', monospace;
      user-select: all;
    }
    .code-placeholder {
      font-size: 13px;
      color: #64748b;
    }
    .copy-btn {
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      border: 1px solid #0284c7;
      background: rgba(2, 132, 199, 0.15);
      color: #38bdf8;
      cursor: pointer;
      display: none;
      align-items: center;
      gap: 6px;
      transition: background 0.15s;
    }
    .copy-btn:hover {
      background: rgba(2, 132, 199, 0.3);
    }
    .status-msg {
      font-size: 12px;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 12px;
      text-align: center;
      display: none;
    }
    .status-msg.info {
      display: block;
      background: rgba(56, 189, 248, 0.1);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.2);
    }
    .status-msg.success {
      display: block;
      background: rgba(34, 197, 94, 0.12);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.25);
    }
    .status-msg.error {
      display: block;
      background: rgba(239, 68, 68, 0.12);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.25);
    }
    .history-card h3 {
      font-size: 13px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .history-card h3 a {
      color: #38bdf8;
      text-decoration: none;
      font-size: 11px;
      text-transform: none;
    }
    .history-card h3 a:hover {
      text-decoration: underline;
    }
    .history-list {
      max-height: 180px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .history-item {
      font-size: 12px;
      padding: 8px 10px;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .history-user {
      font-weight: 600;
      color: #f8fafc;
    }
    .history-code {
      font-family: monospace;
      color: #38bdf8;
      font-weight: 700;
      letter-spacing: 1px;
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 0.8s ease-in-out infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="header-title">
          <svg viewBox="0 0 24 24"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>
          <h1>Central Remote Desktop</h1>
        </div>
        <div class="header-actions">
          <div id="connPill" class="status-pill offline">Conectando...</div>
          <form class="logout-form" method="post" action="/admin/logout">
            <button class="logout-button" type="submit">Sair</button>
          </form>
        </div>
      </div>

      <div class="form-group">
        <label for="userSelect">Selecione o Computador / Usuário:</label>
        <select id="userSelect">
          <option value="">Aguardando conexões de computadores...</option>
        </select>
      </div>

      <div class="btn-group">
        <button id="btnGenerate" class="btn btn-primary" disabled>
          <span id="btnGenIcon">⚡</span>
          <span>Gerar Código</span>
        </button>
        <button id="btnCloseTab" class="btn btn-danger" disabled>
          <span>❌</span>
          <span>Fechar Aba</span>
        </button>
      </div>

      <div id="statusMsg" class="status-msg"></div>

      <div class="code-box">
        <div id="codeDisplay" class="code-placeholder">Selecione um computador acima para operar</div>
        <button id="btnCopy" class="copy-btn">📋 Copiar Código</button>
      </div>
    </div>

    <div class="card history-card">
      <h3>
        <span>Histórico de Códigos</span>
        <a href="https://docs.google.com/spreadsheets/d/1bH1MC8jU6D7oMsqDdZlWRJBLp6vcJlqey8hP_W89pBQ/edit" target="_blank">Abrir Google Sheets ↗</a>
      </h3>
      <div id="historyList" class="history-list">
        <div style="color: #64748b; font-size: 12px; text-align: center; padding: 12px;">Nenhum código gerado recentemente</div>
      </div>
    </div>
  </div>

  <script>
    let ws = null;
    let selectedUser = '';
    let currentCode = '';

    const connPill = document.getElementById('connPill');
    const userSelect = document.getElementById('userSelect');
    const btnGenerate = document.getElementById('btnGenerate');
    const btnCloseTab = document.getElementById('btnCloseTab');
    const btnGenIcon = document.getElementById('btnGenIcon');
    const codeDisplay = document.getElementById('codeDisplay');
    const btnCopy = document.getElementById('btnCopy');
    const statusMsg = document.getElementById('statusMsg');
    const historyList = document.getElementById('historyList');

    function showStatus(text, type = 'info') {
      if (!text) {
        statusMsg.style.display = 'none';
        return;
      }
      statusMsg.className = 'status-msg ' + type;
      statusMsg.textContent = text;
      statusMsg.style.display = 'block';
    }

    function updateActionButtons() {
      const hasUser = Boolean(selectedUser);
      btnGenerate.disabled = !hasUser;
      btnCloseTab.disabled = !hasUser;
      if (!hasUser) {
        codeDisplay.textContent = 'Selecione um computador acima para operar';
        codeDisplay.className = 'code-placeholder';
        btnCopy.style.display = 'none';
      }
    }

    function renderUsers(users) {
      userSelect.innerHTML = '';
      if (!users || users.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '🔴 Nenhum computador conectado no momento';
        userSelect.appendChild(opt);
        selectedUser = '';
      } else {
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = '-- Escolha um computador (' + users.length + ' online) --';
        userSelect.appendChild(defaultOpt);

        users.forEach(u => {
          const opt = document.createElement('option');
          opt.value = u.userId;
          opt.textContent = '🟢 ' + u.userId;
          if (u.userId === selectedUser) opt.selected = true;
          userSelect.appendChild(opt);
        });
      }
      updateActionButtons();
    }

    function renderHistory(history) {
      historyList.replaceChildren();

      if (!history || history.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.style.cssText = 'color: #64748b; font-size: 12px; text-align: center; padding: 12px;';
        emptyState.textContent = 'Nenhum código gerado recentemente';
        historyList.appendChild(emptyState);
        return;
      }

      history.forEach(item => {
        const time = new Date(item.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const row = document.createElement('div');
        row.className = 'history-item';

        const identity = document.createElement('div');
        const user = document.createElement('span');
        user.className = 'history-user';
        user.textContent = String(item.user || 'Desconhecido');

        const timestamp = document.createElement('span');
        timestamp.style.cssText = 'font-size: 11px; color: #64748b; margin-left: 6px;';
        timestamp.textContent = time;

        const code = document.createElement('span');
        code.className = 'history-code';
        code.textContent = String(item.code || '');

        identity.append(user, timestamp);
        row.append(identity, code);
        historyList.appendChild(row);
      });
    }

    function connectWs() {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = wsProtocol + '//' + window.location.host + '/ws?type=dashboard';

      connPill.className = 'status-pill offline';
      connPill.textContent = 'Reconectando...';

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        connPill.className = 'status-pill online';
        connPill.textContent = '🟢 Painel Conectado';
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'INIT') {
            renderUsers(data.users);
            renderHistory(data.history);
          } else if (data.type === 'USERS_UPDATE') {
            renderUsers(data.users);
          } else if (data.type === 'STATUS_UPDATE') {
            if (!selectedUser || data.userId === selectedUser) {
              showStatus(data.message, data.isError ? 'error' : 'info');
            }
          } else if (data.type === 'COMMAND_RESULT') {
            btnGenerate.disabled = false;
            btnGenIcon.textContent = '⚡';

            if (data.action === 'GENERATE_CODE') {
              if (data.success && data.code) {
                currentCode = data.code;
                codeDisplay.textContent = data.code;
                codeDisplay.className = 'code-display';
                btnCopy.style.display = 'inline-flex';
                showStatus('✅ Código gerado com sucesso para ' + data.userId + '!', 'success');
              } else {
                showStatus(data.error || 'Erro ao gerar código.', 'error');
              }
            } else if (data.action === 'CLOSE_TAB') {
              if (data.success) {
                showStatus('Aba do Remote Desktop fechada no computador ' + data.userId + '.', 'info');
              } else {
                showStatus(data.error || 'Erro ao fechar aba.', 'error');
              }
            }
          }
        } catch (e) {
          console.error('Erro ao ler WS:', e);
        }
      };

      ws.onclose = () => {
        connPill.className = 'status-pill offline';
        connPill.textContent = 'Desconectado';
        setTimeout(connectWs, 2500);
      };
    }

    userSelect.addEventListener('change', (e) => {
      selectedUser = e.target.value;
      updateActionButtons();
      if (selectedUser) {
        showStatus('Computador selecionado: ' + selectedUser, 'info');
      }
    });

    btnGenerate.addEventListener('click', () => {
      if (!selectedUser || !ws || ws.readyState !== WebSocket.OPEN) return;
      btnGenerate.disabled = true;
      btnGenIcon.innerHTML = '<span class="spinner"></span>';
      showStatus('Solicitando geração de código para ' + selectedUser + '...', 'info');

      ws.send(JSON.stringify({
        action: 'SEND_COMMAND',
        targetUser: selectedUser,
        command: 'GENERATE_CODE'
      }));
    });

    btnCloseTab.addEventListener('click', () => {
      if (!selectedUser || !ws || ws.readyState !== WebSocket.OPEN) return;
      showStatus('Solicitando fechamento da aba para ' + selectedUser + '...', 'info');

      ws.send(JSON.stringify({
        action: 'SEND_COMMAND',
        targetUser: selectedUser,
        command: 'CLOSE_TAB'
      }));
    });

    btnCopy.addEventListener('click', async () => {
      if (!currentCode) return;
      try {
        await navigator.clipboard.writeText(currentCode);
        const orig = btnCopy.textContent;
        btnCopy.textContent = '✅ Copiado!';
        setTimeout(() => { btnCopy.textContent = orig; }, 1500);
      } catch (_) {}
    });

    connectWs();
  </script>
</body>
</html>
`;
