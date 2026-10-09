﻿﻿﻿﻿﻿$ErrorActionPreference = 'Stop'
$wscRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# 本地安装根按当前用户解析：原实现写死作者机器的用户目录，换机即失效。
$ekkoHome = Join-Path $env:USERPROFILE '.local\share\wsc-hub'
$ekkoEntry = Join-Path $ekkoHome 'ekko\node_modules\ekko-studio\bin\hermes-web-ui.mjs'
if (-not (Test-Path -LiteralPath $ekkoEntry -PathType Leaf)) { throw 'Ekko 安装入口不存在；请先诊断安装。' }
$env:BIND_HOST = '127.0.0.1'
$env:PORT = '8648'
$env:HERMES_WEB_UI_PORT = '8648'
$env:HERMES_WEB_UI_HOME = Join-Path $ekkoHome 'ekko-state'
$env:WORKSPACE_BASE = $wscRoot
$wscPidFile = Join-Path $env:HERMES_WEB_UI_HOME 'server.pid'
$wscRunning = $false
if (Test-Path -LiteralPath $wscPidFile -PathType Leaf) {
    try {
        $wscPid = [int]([IO.File]::ReadAllText($wscPidFile).Trim())
        $wscProcess = Get-Process -Id $wscPid -ErrorAction Stop
        $wscRunning = $wscProcess.ProcessName -eq 'node'
    } catch { $wscRunning = $false }
}
if ($wscRunning) { Write-Output 'Ekko 已在运行；现在核对实际服务配置。' }
else { & node $ekkoEntry start --port 8648 --no-open }
# 现有实例的 CLI 返回 1；只有实际服务配置核验通过才视为可复用。
# 服务就绪核验：回环端口最多等 10 秒。
$ready = $false
foreach ($i in 1..10) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8648' -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ready = $true; break }
    } catch { Start-Sleep -Seconds 1 }
}
if ($ready) { Write-Output ('Ekko 控制面就绪：http://127.0.0.1:8648（工作根 ' + $wscRoot + '）') }
else { throw 'Ekko 控制面未就绪；请检查安装与端口 8648。' }
