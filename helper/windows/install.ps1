# Installs the Speakr Recorder helper for Chrome on Windows (current user only).
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File helper\windows\install.ps1
$ErrorActionPreference = 'Stop'

$HostName    = 'com.baruch.speakr_recorder'
# Extensions allowed to start the helper: the unpacked copy (ID pinned by "key"
# in manifest.json) and the Chrome Web Store item.
$ExtensionIds = @('maddoidjgjmojmknbchikbilcedkmgdc', 'oedfhekaioihehbnhhpcokekpfbennop')
$Dir         = Join-Path $env:LOCALAPPDATA 'SpeakrRecorder'

# Python 3.9+ from the py launcher, else python on PATH.
$python = $null
foreach ($cmd in @(@('py', '-3'), @('python'))) {
    try {
        $exe = & $cmd[0] $cmd[1..9] -c 'import sys; assert sys.version_info >= (3, 9); print(sys.executable)' 2>$null
        if ($LASTEXITCODE -eq 0 -and $exe) { $python = $exe.Trim(); break }
    } catch {}
}
if (-not $python) { throw 'Python 3.9 or newer is required: https://www.python.org/downloads/windows/' }
Write-Host "Using $python"

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# The installer downloaded from the extension settings embeds the helper as
# $HelperPy; run from the repo, the file sits next to this script.
if ($HelperPy) {
    [IO.File]::WriteAllText((Join-Path $Dir 'speakr_helper.py'), $HelperPy, (New-Object Text.UTF8Encoding $false))
} else {
    Copy-Item (Join-Path $PSScriptRoot 'speakr_helper.py') $Dir -Force
}

if (-not (Test-Path (Join-Path $Dir 'venv\Scripts\python.exe'))) {
    & $python -m venv (Join-Path $Dir 'venv')
}
$venvPython = Join-Path $Dir 'venv\Scripts\python.exe'
& $venvPython -m pip install --quiet --disable-pip-version-check 'soundcard==0.4.6' 'numpy>=2.2,<3'
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

# Chrome launches the host as an executable; a .bat hands stdin/stdout to Python.
$launcher = Join-Path $Dir 'speakr_helper.bat'
Set-Content -Path $launcher -Encoding ASCII -Value @(
    '@echo off',
    '"%~dp0venv\Scripts\python.exe" -u "%~dp0speakr_helper.py" %*'
)

$manifest = Join-Path $Dir "$HostName.json"
@{
    name            = $HostName
    description     = 'Speakr Recorder: streams the computer''s sound to the extension'
    path            = $launcher
    type            = 'stdio'
    allowed_origins = @($ExtensionIds | ForEach-Object { "chrome-extension://$_/" })
} | ConvertTo-Json | ForEach-Object {
    # No BOM: Windows PowerShell's UTF8 adds one, and Chrome must parse this file.
    [IO.File]::WriteAllText($manifest, $_, (New-Object Text.UTF8Encoding $false))
}

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest

Write-Host "Installed to $Dir and registered with Chrome."
Write-Host 'Done. In the extension settings, the Windows helper now shows "Installed".'
