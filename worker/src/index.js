import { DurableObject } from 'cloudflare:workers';

const SHEET_ENDPOINT = 'https://script.google.com/macros/s/AKfycbx7OgYnA0OKPgXL9yhWUhdxCz4C7UnapjXWYaSukelqt6u__2wOs1eVZvpetmKmil59/exec';

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
      const type = url.searchParams.get('type') || 'dashboard'; // 'extension' ou 'dashboard'
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
      return Response.json({
        onlineUsersCount: this.extensionClients.size,
        users: Array.from(this.extensionClients.keys()),
        history: this.history
      });
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

    // Endpoint direto para regras dinâmicas do DOM (resposta ultra-rápida na borda)
    if (url.pathname === '/api/dom-rules') {
      return Response.json(DOM_RULES, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    // Roteia conexões WebSocket e endpoints da API para o Durable Object único
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      const id = env.REMOTE_DESKTOP_HUB.idFromName('global-hub');
      const hub = env.REMOTE_DESKTOP_HUB.get(id);
      return hub.fetch(request);
    }

    // Serve a Interface Web do Dashboard Central
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(dashboardHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

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
        <div id="connPill" class="status-pill offline">Conectando...</div>
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
      if (!history || history.length === 0) {
        historyList.innerHTML = '<div style="color: #64748b; font-size: 12px; text-align: center; padding: 12px;">Nenhum código gerado recentemente</div>';
        return;
      }
      let html = '';
      history.forEach(item => {
        const time = new Date(item.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        html += \`
          <div class="history-item">
            <div>
              <span class="history-user">\${item.user}</span>
              <span style="font-size: 11px; color: #64748b; margin-left: 6px;">\${time}</span>
            </div>
            <span class="history-code">\${item.code}</span>
          </div>
        \`;
      });
      historyList.innerHTML = html;
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
