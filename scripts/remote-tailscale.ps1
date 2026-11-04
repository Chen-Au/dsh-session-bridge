param(
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host "[remote] $Text" }

$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
  Write-Step 'Tailscale is not installed.'
  Write-Step 'Install it with: winget install -e --id Tailscale.Tailscale'
  Write-Step 'Then sign in, run: tailscale up'
  exit 1
}

Write-Step 'Tailscale status:'
& $tailscale.Source status
if ($LASTEXITCODE -ne 0) {
  Write-Step 'Tailscale is installed but not connected. Run: tailscale up'
  exit 1
}

$probe = Test-NetConnection -ComputerName 127.0.0.1 -Port 43129 -WarningAction SilentlyContinue
if (-not $probe.TcpTestSucceeded) {
  Write-Step 'DSH Web GUI is not listening on 127.0.0.1:43129. Start DSH Desktop first.'
  exit 1
}

Write-Step 'DSH Web GUI is reachable on 127.0.0.1:43129.'
if (-not $Apply) {
  Write-Step 'Read-only check complete. To start tailnet-only Serve, rerun with -Apply.'
  exit 0
}

Write-Step 'Starting tailscale serve for 127.0.0.1:43129 (tailnet only, not Funnel)...'
& $tailscale.Source serve --bg 43129
if ($LASTEXITCODE -ne 0) {
  Write-Step 'tailscale serve failed. Check `tailscale status` and try again.'
  exit 1
}

Write-Step 'Serve status:'
& $tailscale.Source serve status
Write-Step 'Open the https://*.ts.net URL above from another device in the same tailnet.'
