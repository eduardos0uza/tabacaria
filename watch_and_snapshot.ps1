param(
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

# Watcher de arquivos
$watcher = New-Object System.IO.FileSystemWatcher $root
$watcher.IncludeSubdirectories = $true
$watcher.Filter = '*.*'
$watcher.EnableRaisingEvents = $true

# Timer para debounce (2s após última alteração)
$timer = New-Object System.Timers.Timer
$timer.Interval = 2000
$timer.AutoReset = $false

# Ao disparar o timer, gera snapshot
Register-ObjectEvent -InputObject $timer -EventName Elapsed -SourceIdentifier 'SnapshotTimer' -Action {
    if ($Push) {
        & (Join-Path $root 'snapshot.ps1') -Push
    } else {
        & (Join-Path $root 'snapshot.ps1')
    }
}

function OnChange {
    param($sender, $eventArgs)
    $path = $eventArgs.FullPath
    if ($path -match "\\.git\\" -or $path -match "\\snapshots\\" -or $path -match "\\.github\\") { return }
    $timer.Stop()
    $timer.Start()
}

Register-ObjectEvent -InputObject $watcher -EventName Changed -SourceIdentifier 'FSChanged' -Action { OnChange $sender $eventArgs }
Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier 'FSCreated' -Action { OnChange $sender $eventArgs }
Register-ObjectEvent -InputObject $watcher -EventName Renamed -SourceIdentifier 'FSRenamed' -Action { OnChange $sender $eventArgs }


Write-Host "Observando alterações em '$root'. Pressione Ctrl+C para sair."

try {
    while ($true) { Start-Sleep -Seconds 1 }
} finally {
    Get-EventSubscriber | Where-Object { $_.SourceIdentifier -like 'FS*' -or $_.SourceIdentifier -eq 'SnapshotTimer' } | ForEach-Object { Unregister-Event -SourceIdentifier $_.SourceIdentifier }
    $timer.Dispose()
    $watcher.Dispose()
}
