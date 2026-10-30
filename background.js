/**
 * Remote Desktop Code Generator - Background Service Worker
 * Gerencia a automação da aba e o envio para o Google Sheets (GAS)
 */

const SHEET_ENDPOINT = 'https://script.google.com/macros/s/AKfycbx7OgYnA0OKPgXL9yhWUhdxCz4C7UnapjXWYaSukelqt6u__2wOs1eVZvpetmKmil59/exec';

// Utilitário de espera
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Envia status atualizado para quem estiver ouvindo (popup) e persiste no storage
async function updateStatus(message, isError = false, extraData = {}) {
  const data = {
    statusMessage: message,
    isError,
    statusTimestamp: Date.now(),
    ...extraData
  };
  await chrome.storage.local.set(data);
  try {
    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', ...data });
  } catch (_) {
    // Popup pode estar fechado, sem problemas
  }
}

// Envia código para o Google Apps Script
async function sendCodeToGAS(code) {
  try {
    const response = await fetch(SHEET_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({ code: code })
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // prossegue mesmo no timeout
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
  } catch (_) {
    // Não respondeu, vamos injetar
  }

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

// Fluxo principal de geração de código
async function handleGenerateCode() {
  await updateStatus('Localizando aba do Remote Desktop...', false, { isGenerating: true });

  try {
    let tab = await findRemoteDesktopTab();
    let isNewTab = false;

    if (!tab) {
      await updateStatus('Abrindo https://remotedesktop.google.com/support...', false);
      tab = await chrome.tabs.create({
        url: 'https://remotedesktop.google.com/support',
        active: false // mantém em segundo plano inicialmente para não fechar o popup
      });
      isNewTab = true;
      await waitForTabLoad(tab.id);
      await sleep(1500); // tempo para scripts dinâmicos da página iniciarem
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

    // Ativa a aba do Remote Desktop para o usuário ver o cronômetro de 5 minutos
    try {
      await chrome.tabs.update(tab.id, { active: true });
    } catch (_) {}

    // Envia para a planilha
    await updateStatus(`Código obtido: ${code}! Salvando na planilha...`, false);
    const gasResult = await sendCodeToGAS(code);

    const nowIso = new Date().toISOString();
    const sheetSaved = gasResult && gasResult.success;

    // Atualiza histórico no local storage
    const storageData = await chrome.storage.local.get(['history']);
    const history = storageData.history || [];
    history.push({
      code,
      timestamp: nowIso,
      sheetSaved
    });
    // Manter no máximo 50 itens
    if (history.length > 50) history.shift();

    const finalStatus = sheetSaved
      ? 'Código salvo na planilha e copiado para a área de transferência!'
      : 'Código copiado! (Aviso: falha ao registrar na planilha)';

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
    const msg = err.message || 'Erro inesperado na extensão.';
    await updateStatus(msg, true, { isGenerating: false });
    return { success: false, error: msg };
  }
}

// Ouvinte de mensagens da extensão (popup)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GENERATE_CODE') {
    handleGenerateCode().then(sendResponse);
    return true; // resposta assíncrona
  }

  if (request.action === 'GET_STATUS') {
    chrome.storage.local.get(null).then(sendResponse);
    return true;
  }
});
