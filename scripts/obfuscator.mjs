/**
 * Motor de Ofuscação Avançada — Inspirado no tp2026
 * 
 * Pipeline de 4 Estágios:
 * 1. Análise Léxica & Tokenização (Diferencia strings de valores vs chaves de objetos vs diretivas)
 * 2. String Array Encoding com Cifra XOR Rotativa (todas as strings viram blocos hex criptografados)
 * 3. Embaralhamento Determinístico de Chaves e Injeção do Decodificador em Memória com Cache
 * 4. Minificação e Mangling Profundo com Terser (compressão agressiva e nomes de 1 caractere)
 * 5. Validação Sintática de Integridade (node --check)
 */

import { minify } from 'terser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ----------------------------------------------------
// 1. Tokenizador Léxico Preciso (idêntico ao padrão tp2026)
// ----------------------------------------------------
function tokenizeJs(js) {
  const source = String(js || '');
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Espaços em branco
    if (/[\s]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[\s]/.test(source[j])) j++;
      tokens.push({ type: 'ws', value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Comentário de linha //
    if (ch === '/' && next === '/') {
      let j = i + 2;
      while (j < source.length && source[j] !== '\n' && source[j] !== '\r') j++;
      tokens.push({ type: 'comment', value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Comentário de bloco /* ... */
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length - 1 && !(source[j] === '*' && source[j + 1] === '/')) {
        j++;
      }
      j = j < source.length - 1 ? j + 2 : source.length;
      tokens.push({ type: 'comment', value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Strings literais com aspas simples ou duplas ('...', "...")
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let escaped = false;
      while (j < source.length) {
        if (!escaped && source[j] === quote) {
          j++;
          break;
        }
        if (!escaped && source[j] === '\\') {
          escaped = true;
        } else {
          escaped = false;
        }
        j++;
      }
      tokens.push({ type: 'str', value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Template strings `...` (não codificamos diretamente para não quebrar expressões ${...})
    if (ch === '`') {
      let j = i + 1;
      let escaped = false;
      while (j < source.length) {
        if (!escaped && source[j] === '`') {
          j++;
          break;
        }
        if (!escaped && source[j] === '\\') {
          escaped = true;
        } else {
          escaped = false;
        }
        j++;
      }
      tokens.push({ type: 'template', value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Identificadores e palavras-chave
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[a-zA-Z0-9_$]/.test(source[j])) j++;
      tokens.push({ type: 'id', value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Números
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < source.length && /[0-9a-fA-FxXeEbBoO._]/.test(source[j])) j++;
      tokens.push({ type: 'num', value: source.slice(i, j) });
      i = j;
      continue;
    }

    // Pontuação e operadores
    tokens.push({ type: 'punc', value: ch });
    i++;
  }

  return tokens;
}

// Localiza índice anterior de token significativo (ignorando ws e comments)
function prevSigTokenIndex(tokens, startIdx) {
  for (let i = startIdx; i >= 0; i--) {
    if (tokens[i].type !== 'ws' && tokens[i].type !== 'comment') return i;
  }
  return -1;
}

// Localiza próximo índice de token significativo
function nextSigTokenIndex(tokens, startIdx) {
  for (let i = startIdx; i < tokens.length; i++) {
    if (tokens[i].type !== 'ws' && tokens[i].type !== 'comment') return i;
  }
  return -1;
}

// Verifica se a string literal é uma chave de objeto literal (ex: { 'Content-Type': '...' })
function isObjectLiteralKey(tokens, idx) {
  const nextIdx = nextSigTokenIndex(tokens, idx + 1);
  const prevIdx = prevSigTokenIndex(tokens, idx - 1);
  if (nextIdx === -1 || prevIdx === -1) return false;

  const next = tokens[nextIdx];
  const prev = tokens[prevIdx];

  return (
    next.type === 'punc' &&
    next.value === ':' &&
    prev.type === 'punc' &&
    (prev.value === '{' || prev.value === ',')
  );
}

// Determina com segurança se uma string literal deve ser codificada
function shouldEncodeString(tokens, idx) {
  const token = tokens[idx];
  if (!token || token.type !== 'str') return false;
  if (!token.value || token.value.length <= 2) return false; // Ignora aspas vazias "" ou ''

  const raw = token.value;
  if (raw === "'use strict'" || raw === '"use strict"') return false;

  // Não codifica se for chave de objeto literal
  if (isObjectLiteralKey(tokens, idx)) return false;

  // Não codifica se for parte de import/export
  const prevIdx = prevSigTokenIndex(tokens, idx - 1);
  if (prevIdx !== -1) {
    const prev = tokens[prevIdx];
    if (
      prev.type === 'id' &&
      (prev.value === 'import' || prev.value === 'export' || prev.value === 'from')
    ) {
      return false;
    }
  }

  return true;
}

// Desfaz os escapes da string para extrair o conteúdo binário real
function parseStringLiteral(rawLiteral) {
  const quote = rawLiteral[0];
  const inner = rawLiteral.slice(1, -1);
  try {
    return (new Function(`return ${quote}${inner}${quote}`))();
  } catch (_) {
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

// ----------------------------------------------------
// 2. Codificação String Array com Cifra XOR Rotativa (Padrão tp2026)
// ----------------------------------------------------
function applyStringArrayEncoding(jsCode, filename = 'script') {
  const tokens = tokenizeJs(jsCode);
  if (tokens.length === 0) return jsCode;

  const literalMap = new Map();
  const literalValues = [];
  const tokenReplacementMap = new Map();

  for (let i = 0; i < tokens.length; i++) {
    if (!shouldEncodeString(tokens, i)) continue;

    const raw = tokens[i].value;
    let index = literalMap.get(raw);

    if (index === undefined) {
      const parsed = parseStringLiteral(raw);
      index = literalValues.length;
      literalMap.set(raw, index);
      literalValues.push(parsed);
    }

    tokenReplacementMap.set(i, index);
  }

  if (literalValues.length === 0) {
    return jsCode;
  }

  // Gera sementes determinísticas baseadas no conteúdo
  const seedHash = crypto.createHash('sha256').update(filename + jsCode.length).digest('hex');
  const baseKey = parseInt(seedHash.slice(0, 4), 16) || 0x5a3c;

  // Embaralha índices das strings (Fisher-Yates determinístico)
  const shuffledOrder = Array.from({ length: literalValues.length }, (_, idx) => idx);
  for (let i = shuffledOrder.length - 1; i > 0; i--) {
    const j = (baseKey + i * 37) % (i + 1);
    const tmp = shuffledOrder[i];
    shuffledOrder[i] = shuffledOrder[j];
    shuffledOrder[j] = tmp;
  }

  const shuffledValues = [];
  const originalToShuffled = new Map();
  for (let i = 0; i < shuffledOrder.length; i++) {
    const orig = shuffledOrder[i];
    shuffledValues.push(literalValues[orig]);
    originalToShuffled.set(orig, i);
  }

  // Codificação XOR de cada caractere em 4 dígitos hexadecimais
  const encodedHexStrings = [];
  const decodeKeys = [];

  for (let i = 0; i < shuffledValues.length; i++) {
    const val = String(shuffledValues[i]);
    const key = ((baseKey + i * 43) & 0xffff) || 0x1337;
    decodeKeys.push(key);

    let hex = '';
    for (let p = 0; p < val.length; p++) {
      const mask = (key + p * 19) & 0xffff;
      const enc = val.charCodeAt(p) ^ mask;
      hex += enc.toString(16).padStart(4, '0');
    }
    encodedHexStrings.push(hex);
  }

  // Nomes dos identificadores do decodificador
  const arrName = '_$sa' + seedHash.slice(0, 4);
  const keysName = '_$sk' + seedHash.slice(4, 8);
  const cacheName = '_$sc' + seedHash.slice(8, 12);
  const flagsName = '_$sf' + seedHash.slice(12, 16);
  const getName = '_$sg' + seedHash.slice(16, 20);

  // Decodificador com cache integrado para máxima performance de runtime
  const decoderCode = [
    `const ${arrName}=[${encodedHexStrings.map(h => JSON.stringify(h)).join(',')}];`,
    `const ${keysName}=[${decodeKeys.join(',')}];`,
    `const ${cacheName}=[];`,
    `const ${flagsName}=[];`,
    `function ${getName}(i){`,
    `  if(${flagsName}[i]===1)return ${cacheName}[i];`,
    `  const h=${arrName}[i];const k=${keysName}[i];let o="";`,
    `  for(let p=0;p<h.length;p+=4){`,
    `    const n=parseInt(h.slice(p,p+4),16);`,
    `    o+=String.fromCharCode(n^((k+((p>>2)*19))&65535));`,
    `  }`,
    `  ${cacheName}[i]=o;${flagsName}[i]=1;return o;`,
    `};`
  ].join('');

  // Reconstrói o código substituindo as strings pelo getter da tabela XOR
  const outputParts = [decoderCode, '\n'];
  for (let i = 0; i < tokens.length; i++) {
    const replacementIdx = tokenReplacementMap.get(i);
    if (replacementIdx !== undefined) {
      const finalShuffledIdx = originalToShuffled.get(replacementIdx);
      outputParts.push(`(${getName}(${finalShuffledIdx}))`);
    } else {
      outputParts.push(tokens[i].value);
    }
  }

  return outputParts.join('');
}

// ----------------------------------------------------
// 3. Validação Sintática Local (Garante que a ofuscação não quebra o código)
// ----------------------------------------------------
function validateSyntax(code, label) {
  const tempFile = path.join(os.tmpdir(), `check_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.js`);
  try {
    fs.writeFileSync(tempFile, code, 'utf8');
    execSync(`node --check "${tempFile}"`, { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`[Ofuscação] Falha na validação sintática de ${label}: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tempFile); } catch (_) {}
  }
}

// ----------------------------------------------------
// 4. Pipeline Completa de Ofuscação Avançada
// ----------------------------------------------------
export async function advancedObfuscate(code, filename = 'script.js') {
  console.log(`   [Pipeline] 1/3 Criptografando strings (XOR String Array) em ${filename}...`);
  const encodedCode = applyStringArrayEncoding(code, filename);

  console.log(`   [Pipeline] 2/3 Minificação e Mangling profundo via Terser em ${filename}...`);
  const terserResult = await minify(encodedCode, {
    compress: {
      passes: 3,
      dead_code: true,
      conditionals: true,
      evaluate: true,
      booleans: true,
      loops: true,
      unused: true,
      hoist_funs: true,
      keep_fargs: false,
      drop_console: false // preserva logs de diagnóstico do background
    },
    mangle: {
      toplevel: true,
      properties: false // Preserva APIs do Chrome/Firefox (.sendMessage, .runtime, etc.)
    },
    format: {
      comments: false,
      beautify: false
    }
  });

  if (!terserResult.code) {
    throw new Error(`[Ofuscador] Falha ao minificar ${filename}`);
  }

  console.log(`   [Pipeline] 3/3 Validando integridade sintática (node --check) em ${filename}...`);
  validateSyntax(terserResult.code, filename);

  return terserResult.code;
}
