# Removes the Speakr Recorder helper (current user).
$HostName = 'com.baruch.speakr_recorder'
Remove-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" -Recurse -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'SpeakrRecorder') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Speakr Recorder helper removed.'
