param([int]$Port = 8000)

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Serving $pwd on $prefix"

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $rawPath = $context.Request.Url.AbsolutePath.TrimStart('/')
        $path = [System.Uri]::UnescapeDataString($rawPath)
        if ([string]::IsNullOrWhiteSpace($path)) { $path = 'index.html' }
        $full = Join-Path $pwd $path

        if (Test-Path $full -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $ext = [System.IO.Path]::GetExtension($full).ToLower()
            $mime = switch ($ext) {
                '.html' { 'text/html' }
                '.css'  { 'text/css' }
                '.js'   { 'application/javascript' }
                '.json' { 'application/json' }
                '.png'  { 'image/png' }
                '.jpg'  { 'image/jpeg' }
                '.jpeg' { 'image/jpeg' }
                '.svg'  { 'image/svg+xml' }
                default { 'application/octet-stream' }
            }
            $context.Response.ContentType = $mime
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.StatusCode = 200
        } else {
            $context.Response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
            $context.Response.OutputStream.Write($msg, 0, $msg.Length)
        }
        $context.Response.OutputStream.Close()
    } catch {
        Write-Warning $_
    }
}