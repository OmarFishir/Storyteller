# phone-preview.ps1 -- one-command phone-in-hand preview session.
# Starts the backend + two cloudflared quick tunnels + the Expo dev server,
# writes the (rotating) backend tunnel URL into client/.env BEFORE Expo
# starts (Metro inlines env vars at startup), and prints the phone URL as a
# terminal QR code. Ctrl+C in this window ends the session; spawned
# processes are cleaned up best-effort on exit.
#
# Prereq: cloudflared        winget install --id Cloudflare.cloudflared
# Mock vs real Gemini: this script does NOT touch EXPO_PUBLIC_USE_MOCK --
# set it in client/.env yourself (0/absent = real Gemini for the gut-check).

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Fail($msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Fail "cloudflared not found. Install: winget install --id Cloudflare.cloudflared (then open a fresh shell)"
}

$spawned = @()

function Start-Tunnel($port) {
    $log = Join-Path $env:TEMP "cloudflared-$port.log"
    if (Test-Path $log) { Remove-Item $log -Force }
    $p = Start-Process cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$port" `
        -RedirectStandardError $log -PassThru -WindowStyle Hidden
    $script:spawned += $p
    # cloudflared prints the quick-tunnel URL to stderr within a few seconds
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $log) {
            $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" |
                Select-Object -First 1
            if ($m) { return $m.Matches[0].Value }
        }
        Start-Sleep -Milliseconds 500
    }
    Fail "Tunnel for port $port never printed a trycloudflare.com URL (see $log)"
}

try {
    # 1. Backend (skip if something already listens on :8000)
    $backendUp = Test-NetConnection -ComputerName localhost -Port 8000 `
        -InformationLevel Quiet -WarningAction SilentlyContinue
    if (-not $backendUp) {
        Write-Host "Starting backend on :8000..."
        $p = Start-Process (Join-Path $root "venv\Scripts\uvicorn.exe") `
            -ArgumentList "main:app" -WorkingDirectory $root -PassThru
        $script:spawned += $p
        Start-Sleep -Seconds 3
    }
    else {
        Write-Host "Backend already running on :8000"
    }

    # 2. Tunnel the backend; wire the client to it BEFORE Expo starts
    Write-Host "Tunneling the backend..."
    $backendUrl = Start-Tunnel 8000
    $envPath = Join-Path $root "client\.env"
    $lines = @()
    if (Test-Path $envPath) {
        $lines = @(Get-Content $envPath | Where-Object { $_ -notmatch "^EXPO_PUBLIC_API_URL=" })
    }
    $lines = @("EXPO_PUBLIC_API_URL=$backendUrl") + $lines
    Set-Content -Path $envPath -Value $lines -Encoding ascii
    Write-Host "client/.env -> EXPO_PUBLIC_API_URL=$backendUrl"

    # 3. Tunnel the Expo port (server itself starts in step 5)
    Write-Host "Tunneling the Expo dev server..."
    $clientUrl = Start-Tunnel 8081

    # 4. The phone URL, as a QR code (plain text fallback if segno is missing)
    Write-Host ""
    Write-Host "  Phone URL: $clientUrl" -ForegroundColor Green
    Write-Host ""
    # Force UTF-8 stdout for this call: segno's block characters don't fit in
    # Windows' legacy ANSI codepage (cp1252 etc.), which Python falls back to
    # whenever stdout isn't detected as a real console (e.g. redirected, or
    # some terminal hosts) -- without this, the QR silently degrades to the
    # text fallback below on a very common Windows default.
    $env:PYTHONIOENCODING = "utf-8"
    & (Join-Path $root "venv\Scripts\python.exe") -c "import segno; segno.make('$clientUrl').terminal(compact=True)"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "(QR failed -- type the URL by hand, or: venv\Scripts\pip.exe install segno)"
    }
    Write-Host ""
    Write-Host "Point the iPhone camera at the QR. Starting Expo (Ctrl+C here ends the session)..."

    # 5. Expo dev server, FOREGROUND -- its exit tears the session down
    Set-Location (Join-Path $root "client")
    npx expo start --port 8081
}
finally {
    Set-Location $root
    foreach ($p in $spawned) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "Session ended; tunnels and spawned servers stopped."
}
