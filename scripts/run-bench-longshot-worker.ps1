# 起一次长截图 Electron 基线（scripts/bench-longshot-worker.cjs）。
# 约束：独立 stdout/stderr 文件、有界等待、拿真实 ExitCode；超时只结束本脚本自己的 PID。
# 不按进程名批量结束 Electron，不碰现用进程；窗口全部 show:false，不采屏、不读剪贴板。
param(
  [ValidateSet('worker', 'lifecycle', 'both')][string]$Phase = 'worker',
  [string]$Scene = 'small-steps',
  [int]$Rounds = 3,
  [int]$TimeoutSeconds = 900
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$entry = Join-Path $PSScriptRoot 'bench-longshot-worker.cjs'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logDir "bench-longshot-$Phase-$Scene-$stamp-stdout.txt"
$stderr = Join-Path $logDir "bench-longshot-$Phase-$Scene-$stamp-stderr.txt"
if (-not (Test-Path -LiteralPath $electron)) { throw "缺少 Electron 运行时：$electron" }
if (-not (Test-Path -LiteralPath $entry)) { throw "缺少基线脚本：$entry" }
$env:ELECTRON_RUN_AS_NODE = $null

$arguments = @("`"$entry`"", "--phase=$Phase", "--scene=$Scene", "--rounds=$Rounds")
$proc = Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $root `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$exited = $proc.WaitForExit($TimeoutSeconds * 1000)
$killed = $false
$code = $null
if (-not $exited) {
  $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue
  if ($live -and $live.CommandLine -like '*bench-longshot-worker.cjs*') {
    Stop-Process -Id $proc.Id -Force
    $killed = $true
  }
} else {
  $code = $proc.ExitCode
}

$leftover = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*bench-longshot-worker.cjs*' })

$summary = [ordered]@{
  phase = $Phase
  scene = $Scene
  pid = $proc.Id
  exitCode = $code
  killedByRunner = $killed
  timedOut = (-not $exited)
  stdoutPath = $stdout
  stderrPath = $stderr
  stderrBytes = if (Test-Path -LiteralPath $stderr) { (Get-Item -LiteralPath $stderr).Length } else { -1 }
  leftoverBenchProcesses = $leftover.Count
  stdout = if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Raw -Encoding UTF8 } else { $null }
  stderr = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw -Encoding UTF8 } else { $null }
}
$summary | ConvertTo-Json -Depth 6
if ($code -ne 0 -or $leftover.Count -gt 0) { exit 1 }
exit 0
