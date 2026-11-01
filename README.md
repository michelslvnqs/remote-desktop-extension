# Remote Desktop Code Generator & WebSocket Hub

Solução completa para automatização e controle remoto da geração de códigos no **Google Chrome Remote Desktop** com suporte a **Google Chrome**, **Mozilla Firefox**, integração com **Google Sheets** (Google Drive) e **Hub Central WebSocket via Cloudflare Worker** com **Durable Objects**.

---

## 🚀 Funcionalidades

- **Automação Segura em Segundo Plano**: Opera 100% em segundo plano (`active: false`) sem roubar o foco ou alternar a aba do usuário.
- **Extração Precisa**: Aguarda e extrai o código real de 12 dígitos (`XXXX XXXX XXXX`) gerado pelo Google Remote Desktop.
- **Hub Central WebSocket (Cloudflare Worker)**:
  - Painel Web em tempo real: [https://steep-lake-74ef.michelslvnqs.workers.dev/](https://steep-lake-74ef.michelslvnqs.workers.dev/)
  - Dropdown com todas as máquinas/usuários conectados em tempo real.
  - Disparo remoto dos botões **"⚡ Gerar Código"** e **"❌ Fechar Aba"**.
- **Multiplataforma (Chrome e Firefox)**:
  - Distribuições separadas para Google Chrome e Mozilla Firefox.
  - Versões **Limpas** (para inspeção e envio à AMO Mozilla).
  - Versões **Ofuscadas com Terser** (com mangling de identificadores, compressão e remoção de comentários).
- **Integração com Google Sheets**: Salva Usuário/Máquina, Código e Data/Hora na planilha do Google Drive via Google Apps Script (GAS).
- **Pipeline Automatizado (`npm run build:dist`)**: Gera todas as distribuições e pacotes `.zip` na Área de Trabalho com um único comando.

---

## 📁 Estrutura Modular do Projeto

```
remote-desktop-extension/
├── worker/                          # Backend Cloudflare Worker + Durable Objects + Web Dashboard
│   ├── package.json
│   ├── wrangler.jsonc
│   └── src/
│       └── index.js
├── gas/                             # Google Apps Script para Google Sheets (Google Drive)
│   ├── Code.gs
│   └── GAS_code.txt
├── extension/                       # Código-fonte base da extensão (Chrome MV3)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   └── icons/                       # Ícones 16x16, 48x48 e 128x128
├── distribuicao/                    # Pacotes organizados por navegador e ofuscação
│   ├── chrome/                      # Versão Chrome limpa (desenvolvimento)
│   ├── chrome-minificada/           # Versão Chrome ofuscada com Terser
│   ├── firefox/                     # Versão Firefox limpa (para assinatura na Mozilla AMO)
│   ├── firefox-minificada/          # Versão Firefox ofuscada com Terser
│   ├── *.zip                        # Pacotes compactados gerados pelo pipeline
│   └── docs/
│       └── geracao-xpi-firefox.md   # Guia passo a passo para gerar o .xpi assinado
├── scripts/                         # Pipeline de automação, ofuscação e ZIP
│   ├── build-distribuicao.mjs       # Script principal de build e ofuscação
│   └── make-zip.py                  # Empacotador ZIP com compatibilidade POSIX para AMO
├── package.json                     # Scripts do repositório (npm run build:dist)
├── agents.md                        # Diretrizes de desenvolvimento, padrão-ouro e sem legado
└── .gitignore                       # Arquivos ignorados pelo Git
```

---

## 🛠️ Como Gerar as Distribuições

No terminal do repositório, execute:
```powershell
npm run build:dist
```
Esse comando irá:
1. Montar as pastas em `distribuicao/chrome`, `distribuicao/chrome-minificada`, `distribuicao/firefox` e `distribuicao/firefox-minificada`.
2. Ofuscar e minificar os arquivos JavaScript usando **Terser**.
3. Gerar os 4 pacotes `.zip` e copiá-los diretamente para a sua **Área de Trabalho**:
   - `remote-desktop-chrome.zip`
   - `remote-desktop-chrome-minificada.zip`
   - `remote-desktop-firefox.zip`
   - `remote-desktop-firefox-minificada.zip`

---

## 🌐 Instalação nos Navegadores

### Google Chrome
1. Abra `chrome://extensions/` no Chrome.
2. Ative o **Modo do desenvolvedor** no canto superior direito.
3. Clique em **Carregar sem compactação** e selecione a pasta:  
   👉 `distribuicao/chrome` (para desenvolvimento/código limpo) ou `distribuicao/chrome-minificada` (ofuscada).

### Mozilla Firefox
Para instalar nos seus computadores sem publicar na loja pública da Mozilla:
1. Consulte o guia detalhado em [`distribuicao/docs/geracao-xpi-firefox.md`](distribuicao/docs/geracao-xpi-firefox.md).
2. Envie o arquivo `remote-desktop-firefox.zip` no [Developer Hub da Mozilla](https://addons.mozilla.org/pt-BR/developers/addon/submit/distribution) como **"Faça você mesmo"** (Unlisted).
3. A Mozilla assina o pacote automaticamente em 1 a 2 minutos e libera o arquivo `.xpi` para download.
4. Arraste o `.xpi` assinado para o Firefox ou instale por `about:addons`.

---

## 🔐 Proteção do Painel Administrativo

O painel web, o WebSocket administrativo e a API `/api/status` exigem uma sessão autenticada. A sessão dura 8 horas e utiliza um cookie `HttpOnly`, `Secure` e `SameSite=Strict`, assinado por HMAC.

Antes de publicar o Worker, configure dois segredos no Cloudflare:

- `ADMIN_PASSWORD_HASH`: SHA-256 hexadecimal da senha administrativa.
- `SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres, usado exclusivamente para assinar as sessões.

Cadastre-os com `wrangler secret put` ou pelo painel do Cloudflare. Nunca coloque a senha, seu hash ou a chave de sessão no GitHub. Sem os dois segredos, o painel permanece bloqueado.
