param(
    [switch]$Push,
    [string]$Message
)

$ErrorActionPreference = 'Stop'

# Diretório raiz do projeto
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $Message) { $Message = "Snapshot $ts" }

# Pasta de snapshots
$snapDir = Join-Path $root 'snapshots'
if (!(Test-Path $snapDir)) { New-Item -ItemType Directory -Path $snapDir | Out-Null }

# Caminho do zip
$zipPath = Join-Path $snapDir ("site-$ts.zip")

# Coletar arquivos, excluindo .git e snapshots
$excludeDirs = @('.git', 'snapshots')
$items = Get-ChildItem -Force -Recurse | Where-Object {
    foreach ($ex in $excludeDirs) {
        if ($_.FullName -like "*\$ex\*") { return $false }
    }
    return $true
}

# Criar o zip (sobrescreve se já existir)
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $items -DestinationPath $zipPath

# Função para checar disponibilidade do Git
function GitAvailable {
    try { git --version *>$null; return $true } catch { return $false }
}

# Operações Git opcionais
if (GitAvailable) {
    if (!(Test-Path (Join-Path $root '.git'))) {
        git init
        git branch -M main 2>$null
    }
    git add -A
    $status = git status --porcelain
    if ($status) {
        git commit -m $Message
    } else {
        Write-Host "Sem mudanças para commit."
    }
    $tagName = "snapshot-$ts"
    try { git tag $tagName } catch {}
    if ($Push) {
        try {
            $remotes = git remote
            if ($remotes) {
                git push --tags
                git push
            } else {
                Write-Host "Nenhum remote configurado; pulando push."
            }
        } catch { Write-Warning $_ }
    }
} else {
    Write-Host "Git não disponível; só o snapshot .zip foi gerado."
}

Write-Host "Snapshot gerado: $zipPath"