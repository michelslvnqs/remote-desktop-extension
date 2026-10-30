# Diretrizes de Desenvolvimento para Agentes de IA — Remote Desktop Extension

Este documento estabelece as diretrizes perenes de engenharia, arquitetura, testes, segurança e protocolo de versionamento Git para qualquer agente de IA ou desenvolvedor atuando neste repositório (`remote-desktop-extension`).

---

## 1. Limite de Escopo e Foco de Tarefas

- **Isolamento de Repositório**: Alterações são permitidas estritamente dentro deste repositório (`remote-desktop-extension`). Jamais altere arquivos, configurações ou histórico de outros projetos na pasta `Git` ou no sistema.
- **Uma tarefa por vez**: Concentre-se sempre no pedido mais recente do usuário. Jamais resgate assuntos anteriores para fazer "pacotes" de correções não solicitadas, a menos que o usuário peça explicitamente.
- **Não adivinhe pendências**: Mude apenas o estritamente necessário para atender à solicitação atual.

---

## 2. Padrão-Ouro de Engenharia e Limpeza de Código

- **Sem gambiarras**: Desenvolva soluções limpas, idiomáticas, robustas e sustentáveis.
- **Zero código morto**: Não deixe funções órfãs, variáveis esquecidas, acessos legados ou arquivos de rascunho na raiz. Mantenha a versão mais recente, organizada e profissional possível.
- **Automação em Segundo Plano (Background First)**:
  - Preserve a automação em segundo plano sem mover o mouse físico, digitar no Windows ou roubar o foco da janela do usuário.
  - Para interagir com o DOM do navegador, utilize sempre seletores CSS nativos válidos, eventos sintéticos corretos (`pointerdown`, `mousedown`, `click`) e verificação de visibilidade (`isVisible`).
  - Nunca declare que uma ação atingiu seu objetivo apenas porque o evento foi disparado. Confirme a alteração de estado no DOM (ex: presença do código de 12 dígitos gerado).

---

## 3. Arquivos Locais, Temporários e Higiene de Segurança

- **Arquivos temporários**: Rascunhos, diagnósticos e testes devem residir sempre em `.local/` ou `temp/`, pastas mantidas no `.gitignore`.
- **Higiene e Segurança Absoluta**:
  - **NUNCA versione credenciais, tokens, chaves de API, cookies ou segredos.**
  - Mantenha `.env` e arquivos locais protegidos fora do Git.
  - Adicione ao stage apenas os arquivos pertinentes da tarefa (`git add <arquivos>`), evitando `git add .` indiscriminado que possa capturar arquivos sensíveis.

---

## 4. Validação Local e Testes Obrigatórios Antes do Commit

Nunca comite código com erros de sintaxe ou quebrado. Antes de qualquer commit:

1. **Validação de Sintaxe JavaScript**:
   ```powershell
   node -c background.js content.js popup.js
   ```
2. **Validação de Manifesto e JSON**:
   ```powershell
   Get-Content manifest.json | ConvertFrom-Json | Out-Null
   ```
3. **Teste Funcional na Extensão**:
   - Recarregue a extensão em `chrome://extensions/` pelo botão de recarga (**🔄**).
   - Valide se o popup abre sem erros no console e se a comunicação entre `popup.js`, `background.js` e `content.js` responde conforme o esperado.
   - Verifique o endpoint de integração (Google Apps Script / Webhooks) garantindo que as chamadas `fetch` retornem sucesso.

---

## 5. Rotina Obrigatória de Versionamento (Git, Commit & Push)

Após concluir e validar alterações na base de código ou documentação:

### Passo 1: Verificar arquivos modificados
```powershell
git status
```
Revise o diff para garantir que apenas os arquivos do escopo foram alterados e nenhum arquivo temporário foi adicionado.

### Passo 2: Adicionar ao Stage
```powershell
git add <arquivos-pertinentes>
```

### Passo 3: Commit no padrão Conventional Commits
```powershell
git commit -m "<tipo>: <descrição clara e objetiva>"
```
Tipos obrigatórios:
- `feat:` Nova funcionalidade ou ferramenta adicionada.
- `fix:` Correção de bug ou tratamento de exceção.
- `docs:` Atualizações na documentação ou README.
- `refactor:` Refatoração e melhoria de código sem alteração funcional externa.
- `style:` Ajustes estéticos, CSS ou formatação visual.
- `chore:` Manutenção de dependências, `.gitignore` ou configurações.

### Passo 4: Push para o repositório remoto
```powershell
git push origin main
```
Confirme o resultado do push e informe o hash do commit e as ações realizadas ao usuário. Se o push falhar por restrição de rede ou autenticação, informe claramente o bloqueio sem alegar sucesso falso.

---

## 6. Exceções

- Tarefas exclusivamente de leitura, diagnóstico, inspeção de DOM ou planejamento **não exigem commit nem push**.
- Se o usuário instruir explicitamente para não comitar ou não fazer push, a instrução dele sempre prevalece sobre esta rotina.
