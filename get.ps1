# WaveSync one-line installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/AbhishekVatsh/WaveSync/main/get.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = 'AbhishekVatsh/WaveSync'
$dest = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.wavesync.panel'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('wavesync-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host 'Downloading WaveSync...'
  $zip = Join-Path $tmp 'src.zip'
  Invoke-WebRequest "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $tmp
  $src = Join-Path $tmp 'WaveSync-main'

  # WaveSync isn't signed by Adobe, so Premiere needs permission to load it.
  foreach ($v in 9..13) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
    Set-ItemProperty $key -Name PlayerDebugMode -Value '1'
  }

  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  foreach ($p in 'CSXS', 'js', 'jsx', 'index.html', '.debug') {
    Copy-Item (Join-Path $src $p) $dest -Recurse -Force
  }
  Write-Host "Installed WaveSync to: $dest"

  if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Host 'ffmpeg: found'
  } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing ffmpeg with winget (WaveSync uses it to read audio)...'
    winget install --id Gyan.FFmpeg -e
  } else {
    Write-Host ''
    Write-Host 'ffmpeg is missing. WaveSync needs it to read audio from your clips.'
    Write-Host 'Download it from https://www.gyan.dev/ffmpeg/builds/ and add its bin folder to PATH.'
  }

  Write-Host ''
  Write-Host 'Done. Restart Premiere Pro, then open:  Window > Extensions > WaveSync'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
