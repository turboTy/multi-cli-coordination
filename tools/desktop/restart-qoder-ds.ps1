# 重启 Qoder CN 并装载桌面桥插件（Qoder 必须"完全退出后经启动器启动"）。
#
# 为什么需要：QODER_APP_PLUGIN_DEV_DIRS 等是**进程级**环境变量。
#   · 从开始菜单/任务栏直接打开客户端 → 进程环境里没有它们 → 插件不会被加载；
#   · Start-Process <exe> / cmd start → 本机实测"启动即 exit 0"，几秒后进程归零；
#   · Explorer 用自己的环境块 → 外部注入的变量传不进去。
# 唯一可靠路径：写一个内部 set 好变量的 .cmd，再**经 Explorer 启动这个 .cmd**。
#
# 本脚本：前置检查 → 退干净到 0 进程 → 经 Explorer 启动启动器 → 轮询激活凭据。
# 只操作 Qoder 自身进程；不碰其它客户端、不改任何绑定配置。
#
# ⚠️ 本文件必须以 UTF-8 **带 BOM** 保存：Windows PowerShell 5.1 对无 BOM 文件按 ANSI(GBK)
#    解码，中文注释会导致解析失败（报 "The string is missing the terminator"），
#    而且崩在杀进程之前——症状极易误判成"重启没生效"。详见 PITFALLS.md Qoder 第 9 条。
#
# 用法（本机若只装 PowerShell 5.1，用 powershell.exe 而非 pwsh）：
#   powershell.exe -NoProfile -File tools/desktop/restart-qoder-ds.ps1
# 可用 -BridgeHome 指向你自己的私有桥状态目录（默认 ~/.local/share/wsc-hub/ds-bridge）。
param(
    [string]$BridgeHome = (Join-Path $env:USERPROFILE '.local/share/wsc-hub/ds-bridge'),
    [int]$TimeoutSeconds = 75
)
$ErrorActionPreference = 'Stop'

Write-Host ("PowerShell {0}" -f $PSVersionTable.PSVersion) -ForegroundColor DarkGray

$launcher = Join-Path $BridgeHome 'launch-qoder-ds.cmd'
$keyFile  = Join-Path $BridgeHome 'qoder/state/bridge.key'
$logFile  = Join-Path $BridgeHome 'qoder/state/bridge.log'

Write-Host '== 1) 前置检查 ==' -ForegroundColor Cyan
if (-not (Test-Path $launcher)) { throw "启动器不存在：$launcher`n先把桥部署生成出来（你的部署脚本 / install.ps1）" }
$launcherText = Get-Content $launcher -Raw
if ($launcherText -notmatch 'QODER_APP_PLUGIN_DEV_DIRS') { throw "启动器里没有 QODER_APP_PLUGIN_DEV_DIRS：$launcher" }
Write-Host "  启动器 OK（含插件环境变量）  $launcher"

Write-Host "`n== 2) 退出客户端 ==" -ForegroundColor Cyan
$procs = @(Get-Process | Where-Object { $_.ProcessName -like '*Qoder*' })
if ($procs.Count -gt 0) {
    Write-Host ("  终止 {0} 个进程：{1}" -f $procs.Count, (($procs | Select-Object -ExpandProperty Id | Sort-Object) -join ', '))
    $procs | Stop-Process -Force
} else {
    Write-Host '  没有在跑的客户端进程'
}
# 单实例名额会被残留空壳占用；必须等到真的 0 进程再启动，否则新实例会自己退出
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 700
    $left = @(Get-Process | Where-Object { $_.ProcessName -like '*Qoder*' })
} while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
if ($left.Count -gt 0) { throw "仍有 $($left.Count) 个进程未退出，已中止（不盲目启动，避免单实例移交后自退）" }
Write-Host '  已完全退出（0 进程）'

Write-Host "`n== 3) 经 Explorer 启动启动器 ==" -ForegroundColor Cyan
Start-Process explorer.exe $launcher

Write-Host "`n== 4) 等待插件激活（最多 $TimeoutSeconds 秒）==" -ForegroundColor Cyan
$ok = $false
$t0 = Get-Date
while ((Get-Date) -lt $t0.AddSeconds($TimeoutSeconds)) {
    Start-Sleep -Seconds 3
    if (Test-Path $keyFile) { $ok = $true; break }
    if (((Get-Date) - $t0).TotalSeconds -gt 24) {
        $n = @(Get-Process | Where-Object { $_.ProcessName -like '*Qoder*' }).Count
        Write-Host ("  …{0:N0}s  进程 {1} 个，激活凭据未出现" -f ((Get-Date) - $t0).TotalSeconds, $n) -ForegroundColor DarkGray
    }
}

if ($ok) {
    Write-Host '  ACTIVATED：激活凭据已生成' -ForegroundColor Green
    if (Test-Path $logFile) { Write-Host '  bridge.log 末尾：'; Get-Content $logFile -Tail 5 }
    Write-Host "`n  下一步：用你的派发器 status 核对宿主已连接，再跑 probe.mjs 验闭环"
} else {
    Write-Host "  $TimeoutSeconds 秒内未激活" -ForegroundColor Yellow
    if (Test-Path $logFile) {
        Write-Host '  bridge.log 末尾：'; Get-Content $logFile -Tail 20
    } else {
        Write-Host '  bridge.log 不存在 → 插件根本没被客户端加载'
        Write-Host "`n  证据：启动后主进程命令行"
        Get-CimInstance Win32_Process -Filter "Name like '%Qoder%'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -notmatch '--type=' } |
            Select-Object -First 3 ProcessId, CommandLine | Format-List | Out-String | Write-Host
        Write-Host '  排查：① 是否真的经本脚本启动；② 客户端版本是否仍支持该插件契约；③ 是否装的是预期的发行版。'
    }
}
