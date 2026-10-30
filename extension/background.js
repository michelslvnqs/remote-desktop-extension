/**
 * Remote Desktop Code Generator - Background Service Worker
 * Gerencia a automação da aba, conexão WebSocket com o Hub Cloudflare e envio para Google Sheets (GAS)
 */

const SHEET_ENDPOINT = 'https://script.google.com/macros/s/AKfycbx7OgYnA0OKPgXL9yhWUhdxCz4C7UnapjXWYaSukelqt6u__2wOs1eVZvpetmKmil59/exec';
const WS_BASE_URL = 'wss://steep-lake-74ef.michelslvnqs.workers.dev/ws';

let socket = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let isConnecting = false;

// Utilitário de espera
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Obtém ou inicializa o nome do computador/usuário
async function getMachineName() {
  const data = await chrome.storage.local.get(['machineName']);
  if (data.machineName && data.machineName.trim()) {
    return data.machineName.trim();
  }
  const defaultName = 'PC-' + Math.floor(1000 + Math.random() * 9000);
  await chrome.storage.local.set({ machineName: defaultName });
  return defaultName;
}

// Envia mensagem via WebSocket para o Hub Cloudflare
function sendWs(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(data));
      return true;
    } catch (e) {
      console.warn('[Background] Falha ao enviar WS:', e);
    }
  }
  return false;
}

// Envia atualização de status para o Hub Cloudflare
function sendWsStatus(message, isError = false) {
  sendWs({
    type: 'STATUS_UPDATE',
    message,
    isError
  });
}

// Notifica popup se estiver aberto
function notifyPopup(data) {
  try {
    chrome.runtime.sendMessage(data);
  } catch (_) {
    // Popup fechado, ignorar
  }
}

// Atualiza status no storage local, notifica popup e notifica Hub WS
async function updateStatus(message, isError = false, extraData = {}) {
  const data = {
    statusMessage: message,
    isError,
    statusTimestamp: Date.now(),
    ...extraData
  };
  await chrome.storage.local.set(data);
  notifyPopup({ type: 'STATUS_UPDATE', ...data });
  sendWsStatus(message, isError);
}

// Envia código para o Google Apps Script (Google Drive)
async function sendCodeToGAS(code, user) {
  try {
    const response = await fetch(SHEET_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({
        user: user || 'Extensão',
        code: code,
        source: 'ChromeExtension'
      })
    });
    const data = await response.json();
    return data;
  } catch (err) {
    console.error('[Background] Erro ao enviar para GAS:', err);
    return { success: false, error: err.message };
  }
}

// Localiza aba existente do Suporte Remoto
async function findRemoteDesktopTab() {
  const tabs = await chrome.tabs.query({ url: '*://remotedesktop.google.com/support*' });
  return tabs.length > 0 ? tabs[0] : null;
}

// Aguarda a aba carregar completamente
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Garante que o content script está injetado na aba
async function ensureContentScriptInjected(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
    if (ping && ping.pong) return true;
  } catch (_) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await sleep(400);
    return true;
  } catch (err) {
    console.error('[Background] Falha ao injetar content script:', err);
    throw new Error('Não foi possível injetar o script na página do Remote Desktop.');
  }
}

// Fecha todas as abas do Suporte Remoto
async function closeRemoteDesktopTabs() {
  const tabs = await chrome.tabs.query({ url: '*://remotedesktop.google.com/support*' });
  if (tabs && tabs.length > 0) {
    await chrome.tabs.remove(tabs.map(t => t.id));
    return tabs.length;
  }
  return 0;
}

// Fluxo principal de geração de código
async function handleGenerateCode() {
  const machineName = await getMachineName();
  await updateStatus('Localizando aba do Remote Desktop...', false, { isGenerating: true });

  try {
    let tab = await findRemoteDesktopTab();

    if (!tab) {
      await updateStatus('Abrindo https://remotedesktop.google.com/support...', false);
      tab = await chrome.tabs.create({
        url: 'https://remotedesktop.google.com/support',
        active: false
      });
      await waitForTabLoad(tab.id);
      await sleep(1500);
    } else {
      await updateStatus('Aba do Remote Desktop encontrada!', false);
      if (tab.status !== 'complete') {
        await waitForTabLoad(tab.id);
      }
    }

    // Garante que o content script está pronto
    await ensureContentScriptInjected(tab.id);

    // Solicita ao content script que gere o código
    await updateStatus('Clicando em "Gerar código" no Remote Desktop...', false);

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'GENERATE_CODE' });

    if (!response || !response.success) {
      const errorMsg = (response && response.error) || 'Falha ao obter código da página.';
      await updateStatus(errorMsg, true, { isGenerating: false });
      return { success: false, error: errorMsg };
    }

    const code = response.code;
    console.log('[Background] Código recebido com sucesso:', code);

    // Mantém a aba em segundo plano (active: false) sem roubar o foco do usuário

    // Envia para o Google Sheets via GAS
    await updateStatus(`Código obtido: ${code}! Salvando na planilha...`, false);
    const gasResult = await sendCodeToGAS(code, machineName);

    const nowIso = new Date().toISOString();
    const sheetSaved = gasResult && gasResult.success;

    // Atualiza histórico local
    const storageData = await chrome.storage.local.get(['history']);
    const history = storageData.history || [];
    history.push({
      code,
      timestamp: nowIso,
      sheetSaved
    });
    if (history.length > 50) history.shift();

    const finalStatus = sheetSaved
      ? 'Código salvo na planilha e copiado!'
      : 'Código copiado! (Aviso: falha ao salvar na planilha)';

    await updateStatus(finalStatus, !sheetSaved, {
      isGenerating: false,
      lastCode: code,
      lastTimestamp: nowIso,
      lastSheetSaved: sheetSaved,
      history
    });

    return {
      success: true,
      code,
      sheetSaved,
      timestamp: nowIso
    };

  } catch (err) {
    console.error('[Background] Erro geral:', err);
    const msg = err.message || 'Erro inesperado na automação.';
    await updateStatus(msg, true, { isGenerating: false });
    return { success: false, error: msg };
  }
}

// Agenda reconexão ao WebSocket
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, 3500);
}

// Conecta o WebSocket com o Hub Cloudflare
async function connectWebSocket() {
  if (isConnecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isConnecting = true;
  clearTimeout(reconnectTimer);

  try {
    const machineName = await getMachineName();
    const url = `${WS_BASE_URL}?type=extension&userId=${encodeURIComponent(machineName)}`;
    console.log('[Background] Conectando WebSocket ao Hub:', url);

    socket = new WebSocket(url);

    socket.onopen = async () => {
      console.log('[Background] Conectado ao Hub Cloudflare com sucesso como:', machineName);
      isConnecting = false;
      await chrome.storage.local.set({ wsConnected: true, machineName });
      notifyPopup({ type: 'WS_STATUS', connected: true, machineName });

      // Inicia heartbeat periódico
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'PING' }));
        }
      }, 20000);
    };

    socket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[Background] Mensagem do Hub:', msg);

        if (msg.type === 'PING') {
          sendWs({ type: 'PONG' });
          return;
        }

        // Comando vindo do painel Web: Gerar Código
        if (msg.action === 'GENERATE_CODE') {
          sendWsStatus('Comando Web recebido: Gerando código...', false);
          const result = await handleGenerateCode();
          sendWs({
            type: 'COMMAND_RESULT',
            reqId: msg.reqId,
            action: 'GENERATE_CODE',
            success: result.success,
            code: result.code,
            error: result.error
          });
          return;
        }

        // Comando vindo do painel Web: Fechar Aba
        if (msg.action === 'CLOSE_TAB') {
          sendWsStatus('Comando Web recebido: Fechando aba...', false);
          const closedCount = await closeRemoteDesktopTabs();
          sendWs({
            type: 'COMMAND_RESULT',
            reqId: msg.reqId,
            action: 'CLOSE_TAB',
            success: true,
            closedTabsCount: closedCount
          });
          await updateStatus(
            closedCount > 0 ? 'Aba do Remote Desktop fechada via painel web.' : 'Nenhuma aba aberta encontrada.',
            false
          );
          return;
        }
      } catch (err) {
        console.error('[Background] Erro ao processar mensagem do socket:', err);
      }
    };

    socket.onerror = (err) => {
      console.warn('[Background] Erro no WebSocket:', err);
    };

    socket.onclose = async (event) => {
      console.log('[Background] WebSocket desconectado:', event.code, event.reason);
      isConnecting = false;
      clearInterval(heartbeatTimer);
      await chrome.storage.local.set({ wsConnected: false });
      notifyPopup({ type: 'WS_STATUS', connected: false });
      scheduleReconnect();
    };

  } catch (err) {
    console.error('[Background] Falha ao instanciar WebSocket:', err);
    isConnecting = false;
    scheduleReconnect();
  }
}

// Alarme para manter o Service Worker acordado e reconectar se necessário
chrome.alarms.create('keepAliveAlarm', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAliveAlarm') {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});

// Mensageria interna com o popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GENERATE_CODE') {
    handleGenerateCode().then(sendResponse);
    return true;
  }

  if (request.action === 'CLOSE_TAB') {
    closeRemoteDesktopTabs().then((count) => {
      sendResponse({ success: true, count });
    });
    return true;
  }

  if (request.action === 'GET_STATUS') {
    (async () => {
      const storage = await chrome.storage.local.get(null);
      const machineName = await getMachineName();
      const isWsOpen = socket && socket.readyState === WebSocket.OPEN;
      sendResponse({
        ...storage,
        machineName,
        wsConnected: isWsOpen
      });
    })();
    return true;
  }

  if (request.action === 'SET_MACHINE_NAME') {
    (async () => {
      const newName = (request.name || '').trim();
      if (newName) {
        await chrome.storage.local.set({ machineName: newName });
        if (socket) {
          try { socket.close(1000, 'Nome alterado'); } catch (_) {}
        }
        setTimeout(connectWebSocket, 300);
        sendResponse({ success: true, machineName: newName });
      } else {
        sendResponse({ success: false, error: 'Nome inválido' });
      }
    })();
    return true;
  }

  if (request.action === 'RECONNECT_WS') {
    if (socket) {
      try { socket.close(1000, 'Reconexão manual'); } catch (_) {}
    }
    setTimeout(connectWebSocket, 300);
    sendResponse({ success: true });
    return true;
  }
});

// Inicialização imediata do WebSocket quando o Service Worker carrega
connectWebSocket();
