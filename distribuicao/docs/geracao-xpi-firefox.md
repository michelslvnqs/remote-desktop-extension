# Geração do Arquivo `.xpi` Assinado (Firefox) — Remote Desktop Extension

Este documento descreve o fluxo para gerar o arquivo `.xpi` assinado pela Mozilla para distribuição própria nos seus computadores, sem listar a extensão na loja pública da Mozilla.

---

## 1. Dados Fixos do Projeto

| Item | Valor |
| --- | --- |
| **URL de Envio (AMO)** | `https://addons.mozilla.org/pt-BR/developers/addon/submit/distribution` |
| **Tipo de Distribuição** | **Faça você mesmo** (Unlisted / Não listado publicamente) |
| **ID Gecko da Extensão** | `remote-desktop-hub@michelslvnqs.workers.dev` |
| **Pacote para Envio** | `%USERPROFILE%\Desktop\remote-desktop-firefox.zip` |
| **Saída Final** | Arquivo `.xpi` assinado pela Mozilla |

---

## 2. Passo a Passo para Gerar e Assinar o `.xpi`

### Passo 1: Gerar os Pacotes Atualizados
No terminal do projeto, execute o comando:
```powershell
npm run build:dist
```
Esse comando irá:
1. Montar as versões para Chrome e Firefox (com e sem ofuscação).
2. Criar os pacotes `.zip` e colocá-los diretamente na sua **Área de Trabalho**:
   - `remote-desktop-firefox.zip` (Versão limpa — **ideal para envio à Mozilla**)
   - `remote-desktop-firefox-minificada.zip` (Versão ofuscada com Terser)
   - `remote-desktop-chrome.zip`
   - `remote-desktop-chrome-minificada.zip`

---

### Passo 2: Enviar para a Mozilla (Developer Hub)
1. Acesse o portal da Mozilla Developers:  
   👉 [https://addons.mozilla.org/pt-BR/developers/addon/submit/distribution](https://addons.mozilla.org/pt-BR/developers/addon/submit/distribution)
2. Selecione a opção:  
   🔘 **Faça você mesmo** (*Após seu envio ser assinado pela Mozilla, você pode baixar o arquivo .xpi e distribuir para seu público*).
3. Clique em **Continuar**.
4. Na tela de envio de arquivo, faça o upload de:  
   📁 `C:\Users\<seu-usuario>\Desktop\remote-desktop-firefox.zip`
5. Aguarde o validador automático da Mozilla escanear o arquivo (leva cerca de 30 a 60 segundos).
6. Se perguntar se você precisa fornecer código-fonte de terceiros, selecione **Não** (pois você enviou o pacote limpo padrão).
7. Conclua o envio.

---

### Passo 3: Baixar o `.xpi` Assinado
1. Após a aprovação automática (geralmente de 1 a 3 minutos), a versão ficará com status **Aprovado**.
2. Clique na versão aprovada e faça o download do arquivo `.xpi` assinado gerado pela Mozilla.

---

## 3. Como Instalar no Firefox dos seus PCs
Com o arquivo `.xpi` assinado em mãos:

1. Abra o **Mozilla Firefox**.
2. Digite na barra de endereços: `about:addons` e pressione Enter.
3. Clique no ícone de engrenagem (⚙️) no canto superior direito.
4. Selecione **Instalar extensão a partir de um arquivo...**.
5. Selecione o arquivo `.xpi` assinado e clique em **Adicionar**.
6. Pronto! A extensão estará instalada permanentemente e pronta para se conectar ao Cloudflare Worker!
