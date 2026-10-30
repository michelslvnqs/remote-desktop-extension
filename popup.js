/**
 * Remote Desktop Code Generator - Popup Script
 */

const hubDot = document.getElementById('hubDot');
const hubText = document.getElementById('hubText');
const inputMachineName = document.getElementById('inputMachineName');
const btnSaveMachine = document.getElementById('btnSaveMachine');

const btnGenerate = document.getElementById('btnGenerate');
const btnCloseTab = document.getElementById('btnCloseTab');
const btnIcon = document.getElementById('btnIcon');
const btnText = document.getElementById('btnText');
const codeDisplay = document.getElementById('codeDisplay');
const btnCopy = document.getElementById('btnCopy');
const statusBadge = document.getElementById('statusBadge');
const btnView = document.getElementById('btnView');
const historyPanel = document.getElementById('historyPanel');

let currentCode = null;

// Atualiza o indicador visual da conexão com o Hub WebSocket
function updateHubStatus(connected) {
  if (connected) {
    hubDot.className = 'dot online';
    hubText.textContent = 'Hub Conectado 🟢';
  } else {
    hubDot.className = 'dot offline';
    hubText.textContent = 'Hub Desconectado 🔴';
  }
}

// Exibe mensagem de status com estilo
function showStatus(message, type = 'info') {
  if (!message) {
    statusBadge.style.display = 'none';
    return;
  }
  statusBadge.className = `status-badge ${type}`;
  statusBadge.textContent = message;
  statusBadge.style.display = 'block';
}

// Atualiza a exibição do código
function setCodeDisplay(code) {
  if (code) {
    currentCode = code;
    codeDisplay.textContent = code;
    codeDisplay.className = 'code-display';
    btnCopy.style.display = 'inline-flex';
  } else {
    currentCode = null;
    codeDisplay.textContent = 'Clique em "Gerar Código" para começar';
    codeDisplay.className = 'code-placeholder';
    btnCopy.style.display = 'none';
  }
}

// Configura o estado visual do botão principal
function setButtonLoading(loading) {
  if (loading) {
    btnGenerate.disabled = true;
    btnIcon.innerHTML = '<span class="spinner"></span>';
    btnText.textContent = 'Gerando Código...';
  } else {
    btnGenerate.disabled = false;
    btnIcon.textContent = '⚡';
    btnText.textContent = currentCode ? 'Gerar Novo Código' : 'Gerar Código';
  }
}

// Verifica se a aba do Remote Desktop está aberta e atualiza o botão "Fechar Aba"
async function updateCloseTabButton() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://remotedesktop.google.com/support*' });
    if (tabs && tabs.length > 0) {
      btnCloseTab.style.display = 'flex';
    } else {
      btnCloseTab.style.display = 'none';
    }
  } catch (err) {
    btnCloseTab.style.display = 'none';
  }
}

// Fecha todas as abas do Remote Desktop abertas
async function handleCloseTabClick() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'CLOSE_TAB' });
    if (response && response.success && response.count > 0) {
      showStatus('Aba do Remote Desktop fechada.', 'info');
    } else {
      showStatus('Nenhuma aba do Remote Desktop encontrada.', 'info');
    }
    updateCloseTabButton();
  } catch (err) {
    console.error('[Popup] Erro ao fechar aba:', err);
    showStatus('Erro ao fechar aba do Remote Desktop.', 'error');
  }
}

// Carrega estado salvo do storage e status do background
async function loadSavedState() {
  await updateCloseTabButton();

  try {
    const data = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });

    if (data) {
      updateHubStatus(data.wsConnected);

      if (data.machineName) {
        inputMachineName.value = data.machineName;
      }

      if (data.isGenerating) {
        setButtonLoading(true);
        showStatus(data.statusMessage || 'Processando...', 'info');
      } else {
        setButtonLoading(false);
        if (data.statusMessage) {
          showStatus(data.statusMessage, data.isError ? 'error' : 'success');
        }
      }

      if (data.lastCode) {
        setCodeDisplay(data.lastCode);
      }
    }
  } catch (err) {
    console.warn('[Popup] Erro ao carregar status inicial:', err);
  }
}

// Salva novo nome de máquina
async function handleSaveMachineName() {
  const newName = inputMachineName.value.trim();
  if (!newName) {
    showStatus('Digite um nome válido para este computador.', 'error');
    return;
  }

  const origText = btnSaveMachine.textContent;
  btnSaveMachine.textContent = '...';
  btnSaveMachine.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'SET_MACHINE_NAME',
      name: newName
    });

    if (res && res.success) {
      btnSaveMachine.textContent = 'Salvo!';
      showStatus(`Identificador atualizado para "${newName}". Reconectando ao Hub...`, 'info');
    } else {
      btnSaveMachine.textContent = 'Erro';
      showStatus(res?.error || 'Erro ao salvar identificador.', 'error');
    }
  } catch (err) {
    btnSaveMachine.textContent = 'Erro';
    showStatus('Erro de comunicação.', 'error');
  } finally {
    setTimeout(() => {
      btnSaveMachine.textContent = origText;
      btnSaveMachine.disabled = false;
    }, 1500);
  }
}

// Inicia a geração do código localmente pelo popup
async function handleGenerateClick() {
  setButtonLoading(true);
  showStatus('Iniciando geração de código...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({ action: 'GENERATE_CODE' });

    setButtonLoading(false);
    updateCloseTabButton();

    if (response && response.success) {
      setCodeDisplay(response.code);

      try {
        await navigator.clipboard.writeText(response.code);
      } catch (_) {}

      if (response.sheetSaved) {
        showStatus('✅ Código gerado, salvo na planilha e copiado!', 'success');
      } else {
        showStatus('⚠️ Código copiado! (Aviso: falha ao salvar na planilha)', 'error');
      }
    } else {
      const errorMsg = (response && response.error) || 'Não foi possível gerar o código.';
      showStatus(errorMsg, 'error');
    }
  } catch (err) {
    console.error('[Popup] Erro na requisição:', err);
    setButtonLoading(false);
    updateCloseTabButton();
    showStatus(err.message || 'Erro de comunicação interna na extensão.', 'error');
  }
}

// Copia o código exibido
async function handleCopyClick() {
  if (!currentCode) return;
  try {
    await navigator.clipboard.writeText(currentCode);
    const origText = btnCopy.textContent;
    btnCopy.textContent = '✅ Copiado!';
    setTimeout(() => {
      btnCopy.textContent = origText;
    }, 1500);
  } catch (err) {
    console.error('[Popup] Falha ao copiar:', err);
    showStatus('Falha ao copiar para área de transferência', 'error');
  }
}

// Alterna painel de histórico
async function handleViewClick() {
  if (historyPanel.style.display === 'block') {
    historyPanel.style.display = 'none';
    btnView.textContent = 'Visualizar Histórico';
    return;
  }

  const data = await chrome.storage.local.get(['history']);
  const history = data.history || [];

  if (history.length === 0) {
    historyPanel.innerHTML = '<div style="color: #64748b; font-size: 11px; text-align: center;">Nenhum código gerado ainda</div>';
  } else {
    let html = '<h4>Últimos Códigos</h4>';
    const reversed = [...history].reverse().slice(0, 15);
    reversed.forEach(item => {
      const timeStr = new Date(item.timestamp).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const icon = item.sheetSaved ? '✅' : '⚠️';
      html += `
        <div class="history-item">
          <span class="history-code">${item.code}</span>
          <span style="font-size: 10px; color: #94a3b8;">${timeStr} ${icon}</span>
        </div>
      `;
    });
    historyPanel.innerHTML = html;
  }

  historyPanel.style.display = 'block';
  btnView.textContent = 'Ocultar Histórico';
}

// Ouvir eventos do background em tempo real
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'STATUS_UPDATE') {
    if (msg.isGenerating !== undefined) {
      setButtonLoading(msg.isGenerating);
    }
    if (msg.statusMessage) {
      showStatus(msg.statusMessage, msg.isError ? 'error' : 'info');
    }
    if (msg.lastCode) {
      setCodeDisplay(msg.lastCode);
    }
    updateCloseTabButton();
  }

  if (msg.type === 'WS_STATUS') {
    updateHubStatus(msg.connected);
    if (msg.machineName) {
      inputMachineName.value = msg.machineName;
    }
  }
});

// Event listeners
btnGenerate.addEventListener('click', handleGenerateClick);
btnCloseTab.addEventListener('click', handleCloseTabClick);
btnCopy.addEventListener('click', handleCopyClick);
btnView.addEventListener('click', handleViewClick);
btnSaveMachine.addEventListener('click', handleSaveMachineName);

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  loadSavedState();
  setInterval(updateCloseTabButton, 1200);
  setInterval(async () => {
    try {
      const data = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
      if (data) updateHubStatus(data.wsConnected);
    } catch (_) {}
  }, 3000);
});
