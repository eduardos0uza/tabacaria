# Tabacaria — Automação de versões, deploy e sincronização

Este projeto implementa uma estrutura que:
- Salva todo o site (código, imagens, dados) a cada atualização via snapshots locais (.zip).
- Mantém histórico incremental sem sobrescrever versões antigas.
- Funciona em localhost (scripts PowerShell) e em produção (GitHub Pages/Actions).
- Suporta múltiplos usuários/computadores com fluxo de trabalho Git.

## Como usar em localhost

- Gerar snapshot manual:
  - `powershell -ExecutionPolicy Bypass -File .\\snapshot.ps1`
  - Gera `snapshots/site-YYYYMMDD-HHMMSS.zip` e, se Git estiver disponível, faz commit + tag.
- Monitorar alterações e salvar automaticamente:
  - `powershell -ExecutionPolicy Bypass -File .\\watch_and_snapshot.ps1`
  - Observa mudanças no diretório e cria snapshots com debounce (2s).

## Git local (opcional, recomendado)

1. Instale o Git e Git LFS (para mídias grandes).
2. Inicialize e conecte ao remoto:
   - `git init && git branch -M main`
   - `git remote add origin https://github.com/eduardos0uza/tabacaria.git`
   - `git lfs install` (se usar mídias).
3. Fluxo de trabalho multiusuário:
   - `git pull --rebase` antes de começar.
   - Crie branches por funcionalidade e abra Pull Requests.
   - Use LFS para imagens/arquivos pesados (já configurado em `.gitattributes`).

## CI/CD em produção (GitHub Actions)

- Workflow `CI - Pages & Snapshots`:
  - Publica o site em GitHub Pages em cada push na `main`.
  - Gera artefato `.zip` do site em cada execução (histórico no Actions).
  - Cria Release e anexa o `.zip` quando o push for um tag (`v*` ou `snapshot-*`).
- Endereço do site:
  - `https://eduardos0uza.github.io/tabacaria` (após primeiro push dos arquivos do site).

## Diretórios e arquivos

- `snapshots/` — snapshots locais automáticos em `.zip` (ignorados no Git).
- `.gitattributes` — configura Git LFS para mídias e normalização de EOL.
- `.gitignore` — evita versionar artefatos, logs e snapshots.
- `.github/workflows/ci.yml` — workflow de deploy e artefatos.

## Dicas de colaboração

- Padronize commits e mensagens (ex.: `feat:`, `fix:`, `chore:`).
- Resolva conflitos com `git pull --rebase` e revisões de PR.
- Para arquivos binários (imagens, PDFs, vídeos), use LFS e, se necessário, locks: `git lfs lock <arquivo>`.

## Próximos passos

- Instalar Git no(s) computador(es) de desenvolvimento.
- Fazer o primeiro push do conteúdo do site para o repositório GitHub.
- Habilitar GitHub Pages (o workflow fará isso automaticamente ao rodar).
