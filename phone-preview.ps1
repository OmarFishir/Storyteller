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

# Resolve cloudflared: PATH first, then the MSI's install locations. The
# installer DOES add itself to the machine PATH, but already-running apps
# (VS Code and every terminal inside it) keep the PATH they started with --
# so right after installing, PATH lookup fails until the app restarts.
# Falling back to the literal install paths makes that restart unnecessary.
$cloudflared = $null
$cfCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cfCmd) {
    $cloudflared = $cfCmd.Source
}
else {
    $cfCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "cloudflared\cloudflared.exe"),
        (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe")
    )
    $cloudflared = $cfCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $cloudflared) {
    Fail "cloudflared not found. Install: winget install --id Cloudflare.cloudflared"
}

$spawned = @()

function Start-Tunnel($port) {
    $log = Join-Path $env:TEMP "cloudflared-$port.log"
    if (Test-Path $log) { Remove-Item $log -Force }
    $p = Start-Process $script:cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$port" `
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

    # 4. The phone URL, as a QR code IMAGE opened in a viewer window. (v1
    # rendered the QR in the terminal; a narrow window wraps/crops the block
    # characters and the code won't scan -- a PNG always does. The URL text
    # below is the manual fallback.)
    Write-Host ""
    Write-Host "  Phone URL: $clientUrl" -ForegroundColor Green
    Write-Host ""
    $qrPath = Join-Path $env:TEMP "storyteller-phone-qr.png"
    & (Join-Path $root "venv\Scripts\python.exe") -c "import segno; segno.make('$clientUrl').save(r'$qrPath', scale=10, border=2)"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "QR opened in a window - point the iPhone camera at it."
        Start-Process $qrPath
    }
    else {
        Write-Host "(QR generation failed -- type the URL above into Safari by hand)"
    }
    Write-Host ""
    Write-Host "Scan the QR in the IMAGE WINDOW (or type the Phone URL into Safari)." -ForegroundColor Yellow
    Write-Host "IGNORE the QR Expo prints in this terminal below: that one opens the" -ForegroundColor Yellow
    Write-Host "Expo Go app, which this preview does NOT use (wrong SDK prompt + no" -ForegroundColor Yellow
    Write-Host "voice on native)." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Starting Expo (Ctrl+C here ends the session)..."

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
