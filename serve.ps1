param(
    [string]$Root = (Get-Location),
    [int]$Port = 8000
)

Add-Type -AssemblyName System.Net
Add-Type -AssemblyName System.IO

$prefix = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Static server running at $prefix serving '$Root'"

function Get-ContentType([string]$path) {
    switch ([System.IO.Path]::GetExtension($path).ToLower()) {
        ".html" { "text/html" }
        ".htm"  { "text/html" }
        ".css"  { "text/css" }
        ".js"   { "application/javascript" }
        ".json" { "application/json" }
        ".png"  { "image/png" }
        ".jpg"  { "image/jpeg" }
        ".jpeg" { "image/jpeg" }
        ".svg"  { "image/svg+xml" }
        ".ico"  { "image/x-icon" }
        default  { "application/octet-stream" }
    }
}

while ($true) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $resp = $ctx.Response

    $relPath = $req.Url.AbsolutePath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($relPath) -or $relPath.EndsWith('/')) { $relPath = "index.html" }
    $fullPath = Join-Path $Root $relPath

    if (Test-Path $fullPath -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($fullPath)
        $resp.ContentType = Get-ContentType $fullPath
        $resp.ContentLength64 = $bytes.Length
        $resp.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $resp.StatusCode = 404

        $resp.ContentType = "text/plain"
        $resp.ContentLength64 = $msg.Length
        $resp.OutputStream.Write($msg, 0, $msg.Length)
    }
    $resp.OutputStream.Close()
}
