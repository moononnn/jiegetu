# 录制/导出期间的分进程内存采样：只读进程数据，不接触程序内部、不采屏幕内容。
# 用法：pwsh -File scripts/measure-recording-memory.ps1 -Seconds 600 [-OutFile logs\xx.csv]
param(
  [int]$Seconds = 600,
  [string]$OutFile = ''
)

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) {
  $OutFile = Join-Path $root ('logs\recording-memory-{0}.csv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$dir = Split-Path -Parent $OutFile
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

"at,pid,type,workingSetMB,commitMB" | Set-Content -LiteralPath $OutFile -Encoding utf8
$deadline = (Get-Date).AddSeconds($Seconds)
Write-Output "sampling -> $OutFile (${Seconds}s)"

while ((Get-Date) -lt $deadline) {
  $stamp = (Get-Date).ToString('HH:mm:ss.fff')
  $rows = Get-CimInstance Win32_Process -Filter "Name='截个图.exe'" -ErrorAction SilentlyContinue
  foreach ($proc in $rows) {
    $type = if ($proc.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'main' }
    $ws = [math]::Round($proc.WorkingSetSize / 1MB, 1)
    $commit = [math]::Round($proc.PageFileUsage / 1MB, 1)
    "$stamp,$($proc.ProcessId),$type,$ws,$commit" | Add-Content -LiteralPath $OutFile -Encoding utf8
  }
  Start-Sleep -Milliseconds 500
}
Write-Output 'sampling done'