/**
 * Remote Desktop Code Generator - Content Script
 * Executa na página https://remotedesktop.google.com/support
 */

console.log('[RemoteDesktopExtension] Content script carregado em:', window.location.href);

// Função utilitária de espera
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Verifica visibilidade de um elemento
function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
}

// Dispara clique completo (pointer, mouse, click nativo)
function triggerClick(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const eventOpts = {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    buttons: 1
  };
  try { el.dispatchEvent(new PointerEvent('pointerdown', eventOpts)); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mousedown', eventOpts)); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', eventOpts)); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mouseup', eventOpts)); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('click', eventOpts)); } catch (_) {}
  if (typeof el.click === 'function') {
    try { el.click(); } catch (_) {}
  }
}

// Fallback de cópia usando textarea
function copyToClipboardFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch (err) {
    console.warn('[RemoteDesktopExtension] Falha no fallback de cópia:', err);
  }
  ta.remove();
}

// Copia o código para a área de transferência
async function copyCode(text, copyBtn) {
  if (copyBtn) {
    try {
      triggerClick(copyBtn);
    } catch (_) {}
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    copyToClipboardFallback(text);
  }
}

// Localiza o código de 12 dígitos na página (ex: 3985 2013 0314)
function extract12DigitCode() {
  // 1. Procura primeiro ao lado do botão nativo de cópia do Google
  const copyBtn = document.querySelector(
    '[aria-label*="Copiar c"], [aria-label*="Copy access code"], [aria-label*="Copiar"], [aria-label*="Copy"]'
  );

  if (copyBtn) {
    // Procura no container pai
    const container = copyBtn.closest('div[role="region"]') ||
                      copyBtn.parentElement?.parentElement?.parentElement ||
                      copyBtn.parentElement;
    if (container) {
      const text = container.innerText || container.textContent || '';
      const match = text.match(/\b(\d{4})[\s\u00a0-]?(\d{4})[\s\u00a0-]?(\d{4})\b/);
      if (match) {
        return {
          formatted: `${match[1]} ${match[2]} ${match[3]}`,
          raw: `${match[1]}${match[2]}${match[3]}`,
          copyBtn
        };
      }
    }
  }

  // 2. Procura em todo o texto da página por um padrão de 12 dígitos
  const bodyText = document.body.innerText || document.body.textContent || '';
  const match = bodyText.match(/\b(\d{4})[\s\u00a0-]?(\d{4})[\s\u00a0-]?(\d{4})\b/);
  if (match) {
    return {
      formatted: `${match[1]} ${match[2]} ${match[3]}`,
      raw: `${match[1]}${match[2]}${match[3]}`,
      copyBtn: copyBtn || null
    };
  }

  return null;
}

// Localiza o botão "Gerar código" correto
function findGenerateButton() {
  // 1. Pelo aria-label exato
  const ariaSelectors = [
    '[aria-label="Gerar código"]',
    '[aria-label="Gerar codigo"]',
    '[aria-label="Generate code"]',
    '[aria-label*="Gerar c"]',
    '[aria-label*="Generate code"]'
  ];

  for (const sel of ariaSelectors) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) return el;
  }

  // 2. Procura botões ou divs com role="button" pelo texto
  const candidates = document.querySelectorAll('button, [role="button"], div[role="button"]');
  for (const el of candidates) {
    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (
      text === 'gerar código' ||
      text === 'gerar codigo' ||
      text === '+ gerar código' ||
      text === '+ gerar codigo' ||
      text === 'generate code' ||
      text === '+ generate code' ||
      aria.includes('gerar c') ||
      aria.includes('generate code')
    ) {
      if (isVisible(el)) return el;
    }
  }

  // 3. Procura especificamente dentro do card "Compartilhar esta tela" / "Share this screen"
  const allSections = document.querySelectorAll('section, div');
  for (const sec of allSections) {
    const h = sec.querySelector('h1, h2, h3');
    if (h && (h.textContent.includes('Compartilhar esta tela') || h.textContent.includes('Share this screen'))) {
      const clickables = sec.querySelectorAll('button, [role="button"], div[tabindex="0"]');
      for (const c of clickables) {
        const t = (c.innerText || c.textContent || '').trim().toLowerCase();
        if (t.includes('gerar') || t.includes('generate')) {
          if (isVisible(c)) return c;
        }
      }
    }
  }

  return null;
}

// Fluxo principal de geração do código
async function performCodeGeneration() {
  console.log('[RemoteDesktopExtension] Iniciando performCodeGeneration...');

  // Verifica se está na página de login do Google
  if (window.location.href.includes('accounts.google.com')) {
    return {
      success: false,
      error: 'Você precisa fazer login na sua Conta Google no Chrome Remote Desktop.'
    };
  }

  // 1. Verifica se já existe um código ativo gerado na tela
  const existingCode = extract12DigitCode();
  if (existingCode) {
    console.log('[RemoteDesktopExtension] Código já ativo encontrado:', existingCode.formatted);
    await copyCode(existingCode.formatted, existingCode.copyBtn);
    return {
      success: true,
      code: existingCode.formatted,
      rawCode: existingCode.raw,
      message: 'Código ativo recuperado da tela'
    };
  }

  // 2. Localiza o botão "Gerar código"
  let btn = findGenerateButton();

  // Se não encontrar de imediato, aguarda até 3 segundos para a interface assíncrona terminar de carregar
  if (!btn) {
    console.log('[RemoteDesktopExtension] Botão não encontrado de imediato, aguardando 2s...');
    await sleep(2000);
    btn = findGenerateButton();
  }

  if (!btn) {
    // Verifica se precisa aceitar e instalar o componente de host
    const bodyText = document.body.innerText || '';
    if (bodyText.includes('Aceitar e instalar') || bodyText.includes('Faça o download')) {
      return {
        success: false,
        error: 'É necessário clicar em "Aceitar e instalar" no Chrome Remote Desktop antes de gerar o código.'
      };
    }
    return {
      success: false,
      error: 'Botão "Gerar código" não foi encontrado na seção "Compartilhar esta tela".'
    };
  }

  console.log('[RemoteDesktopExtension] Botão "Gerar código" encontrado! Clicando...');
  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(300);
  triggerClick(btn);

  // 3. Aguarda até 20 segundos pela resposta do servidor do Google e renderização do código
  console.log('[RemoteDesktopExtension] Aguardando código de 12 dígitos...');
  const maxWaitMs = 20000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(400);

    const generated = extract12DigitCode();
    if (generated) {
      console.log('[RemoteDesktopExtension] Código gerado com sucesso:', generated.formatted);
      await copyCode(generated.formatted, generated.copyBtn);
      return {
        success: true,
        code: generated.formatted,
        rawCode: generated.raw,
        message: 'Código gerado com sucesso'
      };
    }

    // Se aparecer botão "Cancelar", o processo está em andamento ou o código está para aparecer
    const cancelBtn = document.querySelector('[aria-label*="Cancelar"], [aria-label*="Cancel"]');
    if (cancelBtn) {
      // Pequena espera adicional para os números renderizarem
      await sleep(500);
      const generatedRetry = extract12DigitCode();
      if (generatedRetry) {
        await copyCode(generatedRetry.formatted, generatedRetry.copyBtn);
        return {
          success: true,
          code: generatedRetry.formatted,
          rawCode: generatedRetry.raw,
          message: 'Código gerado com sucesso'
        };
      }
    }
  }

  return {
    success: false,
    error: 'Tempo limite esgotado: o Google não retornou o código em 20 segundos. Verifique sua conexão.'
  };
}

// Ouvinte de mensagens da extensão
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING') {
    sendResponse({ pong: true });
    return true;
  }

  if (request.action === 'GENERATE_CODE') {
    performCodeGeneration()
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('[RemoteDesktopExtension] Erro durante geração:', err);
        sendResponse({ success: false, error: err.message || 'Erro desconhecido' });
      });
    return true; // Manter canal aberto para resposta assíncrona
  }
});
