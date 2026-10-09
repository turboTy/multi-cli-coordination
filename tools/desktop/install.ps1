param([ValidateSet('trae','workbuddy')][string]$Client)
$ErrorActionPreference = 'Stop'
$taskBase = Join-Path $env:USERPROFILE '.local/share/wsc-hub/desktop-packages'
New-Item -ItemType Directory -Path $taskBase -Force | Out-Null

if ($Client -eq 'workbuddy') {
    $taskTarget = Join-Path $env:USERPROFILE '.workbuddy/extensions-dev/wsc-coordination-bridge'
    if (Test-Path -LiteralPath $taskTarget) {
        $taskBackup = Join-Path $taskBase ('wb-backup-' + [guid]::NewGuid().ToString())
        Copy-Item -LiteralPath $taskTarget -Destination $taskBackup -Recurse
    }
    New-Item -ItemType Directory -Path $taskTarget -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'workbuddy') | Copy-Item -Destination $taskTarget -Recurse -Force
    Write-Output 'WB extension installed; restart WorkBuddy to load it.'
    exit 0
}

$taskMeta = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'trae/package.json') -Raw | ConvertFrom-Json
$taskStage = Join-Path $taskBase ([guid]::NewGuid().ToString())
$taskExt = Join-Path $taskStage 'extension'
New-Item -ItemType Directory -Path $taskExt -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'trae') | Copy-Item -Destination $taskExt -Recurse -Force

$taskContentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'
$taskContentTypesPath = Join-Path $taskStage ([char]91 + 'Content_Types' + [char]93 + '.xml')
$taskContentTypes | Set-Content -LiteralPath $taskContentTypesPath -Encoding utf8

$taskManifest = '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="zh-CN" Id="__NAME__" Version="__VERSION__" Publisher="__PUBLISHER__"/><DisplayName>__DISPLAY_NAME__</DisplayName><Description xml:space="preserve">__DESCRIPTION__</Description><Tags/><Categories>Other</Categories><GalleryFlags/><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="__ENGINE__"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>'
$taskManifest = $taskManifest.Replace('__NAME__', $taskMeta.name).Replace('__VERSION__', $taskMeta.version).Replace('__PUBLISHER__', $taskMeta.publisher).Replace('__DISPLAY_NAME__', $taskMeta.displayName).Replace('__DESCRIPTION__', $taskMeta.description).Replace('__ENGINE__', $taskMeta.engines.vscode)
$taskManifest | Set-Content -LiteralPath (Join-Path $taskStage 'extension.vsixmanifest') -Encoding utf8

$taskVsix = Join-Path $taskBase ('wsc-coordination-bridge-' + $taskMeta.version + '-' + [guid]::NewGuid().ToString() + '.vsix')
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($taskStage, $taskVsix)

# vsix 部署形态下扩展无法从安装目录推导仓库根，先把仓库根写入用户目录下的独立部署配置（UTF-8 无 BOM）。
$taskBridgeHome = Join-Path $env:USERPROFILE '.local/share/wsc-hub/desktop-bridge'
New-Item -ItemType Directory -Path $taskBridgeHome -Force | Out-Null
$taskDeployRoot = ((Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path -replace '\\', '/')
$taskDeployConfig = Join-Path $taskBridgeHome 'trae-deploy.json'
$taskDeployJson = ([pscustomobject]@{ schemaVersion = 1; client = 'trae'; root = $taskDeployRoot } | ConvertTo-Json -Compress)
[System.IO.File]::WriteAllText($taskDeployConfig, $taskDeployJson, (New-Object System.Text.UTF8Encoding($false)))

# 本机 TRAE 与旧机 Trae CN 的 CLI 目录名不同，取第一个存在的候选。
$taskCliCandidates = @((Join-Path $env:LOCALAPPDATA 'Programs/TRAE/bin/trae-cn.cmd'), (Join-Path $env:LOCALAPPDATA 'Programs/Trae CN/bin/trae-cn.cmd'))
$taskCli = $taskCliCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $taskCli) { throw ('Trae CN CLI not found; checked: ' + ($taskCliCandidates -join ', ')) }
& $taskCli --install-extension $taskVsix --force
if ($LASTEXITCODE -ne 0) { throw 'TRAE extension installation failed' }
Write-Output ('TRAE bridge ' + $taskMeta.version + ' installed with root ' + $taskDeployRoot + '; reload the TRAE window to activate it, then verify the running status.')
