# Remote Desktop Code Generator

Extensão para Google Chrome (Manifest V3) desenvolvida para automatizar a geração de códigos de suporte no **Google Chrome Remote Desktop** e sincronizá-los diretamente com uma planilha no **Google Sheets** (Google Drive).

---

## 🚀 Funcionalidades

- **Automação Segura em Segundo Plano**: Abre (se necessário) a aba do Google Remote Desktop e clica no botão oficial de geração sob a seção *"Compartilhar esta tela"*.
- **Extração Precisa**: Aguarda e extrai o código real de 12 dígitos (`XXXX XXXX XXXX`) gerado pelo Google.
- **Cópia Instantânea**: Copia automaticamente o código para a área de transferência do usuário.
- **Integração com Google Sheets**: Salva o código com timestamp em uma planilha via Google Apps Script (GAS).
- **Controle de Sessão**:
  - Alerta visual para manter a aba aberta durante a conexão do suporte.
  - Botão dinâmico **"Fechar Aba do Remote"** que fica visível apenas enquanto a aba de suporte estiver aberta.
- **Histórico Local**: Armazena e exibe os últimos códigos gerados com status de sincronização.

---

## 📁 Estrutura do Projeto

```
remote-desktop-extension/
├── manifest.json       # Manifesto de configuração da extensão (MV3)
├── background.js      # Service Worker para orquestração de abas e comunicação com GAS
├── content.js         # Script de automação injetado em remotedesktop.google.com/support
├── popup.html         # Interface da extensão (Dark Mode)
├── popup.js           # Lógica do painel popup e listeners de eventos
├── Code.gs            # Código do Google Apps Script (Web App) para doPost e doGet
├── GAS_code.txt       # Cópia do código GAS para referência
├── agents.md          # Diretrizes perenes de engenharia, Git e testes para agentes de IA
└── .gitignore         # Arquivos e pastas ignorados pelo Git
```

---

## 🛠️ Instalação e Uso

1. Abra o Google Chrome e navegue até `chrome://extensions/`.
2. Ative o **Modo do desenvolvedor** no canto superior direito.
3. Clique em **Carregar sem compactação** (Load unpacked).
4. Selecione esta pasta (`c:\Users\miche\Desktop\Git\remote-desktop-extension`).
5. Fixe a extensão na barra de ferramentas do Chrome.
6. Clique no ícone da extensão e depois em **"Gerar Código"**.
