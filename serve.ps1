Add-Type -AssemblyName System.Net.HttpListener
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8000/")
$listener.Start()
Write-Host "Static server on http://localhost:8000/"
while ($true) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response
    $relativePath = $req.Url.AbsolutePath.TrimStart("/")
    if ([string]::IsNullOrEmpty($relativePath)) { $relativePath = "index.html" }
    $fullPath = Join-Path (Get-Location) $relativePath
    if ((Test-Path $fullPath) -and -not (Test-Path -Path $fullPath -PathType Container)) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
            switch ($ext) {
                ".html" { $res.ContentType = "text/html" }
                ".css" { $res.ContentType = "text/css" }
                ".js" { $res.ContentType = "application/javascript" }
                ".json" { $res.ContentType = "application/json" }
                ".png" { $res.ContentType = "image/png" }
                ".jpg" { $res.ContentType = "image/jpeg" }
                ".jpeg" { $res.ContentType = "image/jpeg" }
                default { $res.ContentType = "application/octet-stream" }
            }
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } catch {
            $res.StatusCode = 500
            $errBytes = [System.Text.Encoding]::UTF8.GetBytes("Server error: $($_.Exception.Message)")
            $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
        }
    } else {
        $res.StatusCode = 404
        $errBytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
    }
    $res.OutputStream.Close()
}