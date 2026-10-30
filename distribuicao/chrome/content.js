/**
 * Remote Desktop Code Generator - Content Script
 * Executa na página https://remotedesktop.google.com/support
 * 
 * Suporta regras e seletores dinâmicos enviados diretamente pelo Cloudflare Worker
 * Se o Google alterar o DOM, as regras são atualizadas no Worker e refletidas aqui
 * sem necessidade de reinstalar a extensão.
 */

console.log('[RemoteDesktopExtension] Content script carregado em:', window.location.href);

// Regras padrão de fallback (caso o servidor esteja offline)
const DEFAULT_DOM_RULES = {
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

// Cria regex dinâmico com base nas regras fornecidas pelo Worker
function getCodeRegex(rules) {
  const pattern = (rules && rules.codeRegex) || DEFAULT_DOM_RULES.codeRegex;
  try {
    return new RegExp(pattern);
  } catch (_) {
    return new RegExp(DEFAULT_DOM_RULES.codeRegex);
  }
}

// Localiza o código de 12 dígitos na página usando as regras dinâmicas
function extract12DigitCode(rules) {
  const copySelectors = (rules && rules.copySelectors) || DEFAULT_DOM_RULES.copySelectors;
  const regex = getCodeRegex(rules);

  // 1. Procura primeiro ao lado dos botões nativos de cópia especificados nas regras
  for (const sel of copySelectors) {
    try {
      const copyBtn = document.querySelector(sel);
      if (copyBtn) {
        const container = copyBtn.closest('div[role="region"]') ||
                          copyBtn.parentElement?.parentElement?.parentElement ||
                          copyBtn.parentElement;
        if (container) {
          const text = container.innerText || container.textContent || '';
          const match = text.match(regex);
          if (match) {
            return {
              formatted: `${match[1]} ${match[2]} ${match[3]}`,
              raw: `${match[1]}${match[2]}${match[3]}`,
              copyBtn
            };
          }
        }
      }
    } catch (_) {}
  }

  // 2. Procura em todo o texto da página pelo regex
  const bodyText = document.body.innerText || document.body.textContent || '';
  const match = bodyText.match(regex);
  if (match) {
    return {
      formatted: `${match[1]} ${match[2]} ${match[3]}`,
      raw: `${match[1]}${match[2]}${match[3]}`,
      copyBtn: null
    };
  }

  return null;
}

// Localiza o botão "Gerar código" com base nas regras dinâmicas
function findGenerateButton(rules) {
  const generateSelectors = (rules && rules.generateSelectors) || DEFAULT_DOM_RULES.generateSelectors;
  const textKeywords = (rules && rules.buttonTextKeywords) || DEFAULT_DOM_RULES.buttonTextKeywords;
  const containerLabels = (rules && rules.containerLabels) || DEFAULT_DOM_RULES.containerLabels;

  // 1. Pelos seletores do Worker
  for (const sel of generateSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    } catch (_) {}
  }

  // 2. Pelas palavras-chave em botões
  const candidates = document.querySelectorAll('button, [role="button"], div[role="button"]');
  for (const el of candidates) {
    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    for (const kw of textKeywords) {
      const kwLower = kw.toLowerCase();
      if (text === kwLower || aria === kwLower || aria.includes(kwLower)) {
        if (isVisible(el)) return el;
      }
    }
  }

  // 3. Dentro dos containers especificados
  const allSections = document.querySelectorAll('section, div');
  for (const sec of allSections) {
    const h = sec.querySelector('h1, h2, h3');
    if (h) {
      const hText = (h.textContent || '').toLowerCase();
      const matchesContainer = containerLabels.some(l => hText.includes(l.toLowerCase()));
      if (matchesContainer) {
        const clickables = sec.querySelectorAll('button, [role="button"], div[tabindex="0"]');
        for (const c of clickables) {
          const t = (c.innerText || c.textContent || '').trim().toLowerCase();
          if (t.includes('gerar') || t.includes('generate')) {
            if (isVisible(c)) return c;
          }
        }
      }
    }
  }

  return null;
}

// Fluxo principal de geração do código orientado a regras dinâmicas
async function performCodeGeneration(domRules) {
  const rules = domRules || DEFAULT_DOM_RULES;
  console.log('[RemoteDesktopExtension] Iniciando performCodeGeneration com versão de regras:', rules.version || 'default');

  // Verifica se está na página de login do Google
  if (window.location.href.includes('accounts.google.com')) {
    return {
      success: false,
      error: 'Você precisa fazer login na sua Conta Google no Chrome Remote Desktop.'
    };
  }

  // 1. Verifica se já existe um código ativo gerado na tela
  const existingCode = extract12DigitCode(rules);
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
  let btn = findGenerateButton(rules);

  if (!btn) {
    console.log('[RemoteDesktopExtension] Botão não encontrado de imediato, aguardando 2s...');
    await sleep(2000);
    btn = findGenerateButton(rules);
  }

  if (!btn) {
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

  // 3. Aguarda resposta e renderização do código com timeouts das regras
  const maxWaitMs = rules.maxWaitMs || DEFAULT_DOM_RULES.maxWaitMs;
  const pollIntervalMs = rules.pollIntervalMs || DEFAULT_DOM_RULES.pollIntervalMs;
  const cancelSelectors = rules.cancelSelectors || DEFAULT_DOM_RULES.cancelSelectors;
  const startTime = Date.now();

  console.log(`[RemoteDesktopExtension] Aguardando código de 12 dígitos (max: ${maxWaitMs}ms)...`);

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(pollIntervalMs);

    const generated = extract12DigitCode(rules);
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

    // Se aparecer botão "Cancelar", o processo está em andamento
    for (const cancelSel of cancelSelectors) {
      try {
        const cancelBtn = document.querySelector(cancelSel);
        if (cancelBtn) {
          await sleep(400);
          const generatedRetry = extract12DigitCode(rules);
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
      } catch (_) {}
    }
  }

  return {
    success: false,
    error: 'Tempo limite esgotado: o Google não retornou o código em tempo hábil. Verifique sua conexão.'
  };
}

// Ouvinte de mensagens da extensão
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING') {
    sendResponse({ pong: true });
    return true;
  }

  if (request.action === 'GENERATE_CODE') {
    performCodeGeneration(request.domRules)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('[RemoteDesktopExtension] Erro durante geração:', err);
        sendResponse({ success: false, error: err.message || 'Erro desconhecido' });
      });
    return true;
  }
});
