#requires -Version 5.1
# 注意 1：本文件必须保存为 “UTF-8 with BOM”。Windows PowerShell 5.1 会把无 BOM 的文件按 ANSI 解码，
#         中文注释/字符串会乱码并导致解析失败（用记事本另存为 UTF-8 BOM 即可；PowerShell 7 无此问题）。
# 注意 2：系统默认执行策略会拦截 .ps1。用下面的方式运行即可（不需要改全局策略、不需要管理员）：
#         powershell -NoProfile -ExecutionPolicy Bypass -File .\安装到DSH.ps1 -Install
<#
.SYNOPSIS
    把工作区里的本地自研 DSH 插件（默认 session-bridge\dsh-plugin）安装 / 卸载 / 验证 / 回滚到
    当前 DSH Desktop profile（默认 profiles\web）。

.DESCRIPTION
    原理：只改 profile 的 cordis.patch.yml，追加/删除一个带标记的 insert 块，把插件的
    「内容哈希副本」以绝对路径挂进 Cordis 插件树。DSH 的 HMR 监听该文件，约 1~3 秒热重组，
    不需要重启 DSH，不需要装 npm 包，不改 package.json / node_modules / .plugin-manager / .dsh-market。

    为什么每次安装都要复制成新哈希文件：DSH 热重组复用 Node 模块缓存，同一个文件路径改内容不会
    重新 import；哈希文件名 = 新 URL，配合新 id = 新 Loader 条目，才能拿到最新代码（微信桥先例同款）。

    安全措施：
      * 写前把 cordis.patch.yml 备份成 cordis.patch.yml.bak-<时间戳>；
      * 写前用宿主自带的 js-yaml 校验合并后的 YAML（兼容 !!js 标签），校验不过绝不写；
      * 原子写（临时文件 + Move-Item），写完回读比对；
      * 安装中途失败自动回滚（恢复备份、删除新哈希副本）；
      * 卸载时若 patch 只剩注释，自动写成 []（空/纯注释 patch 会导致下次启动失败）；
      * -DryRun 只打印不落盘。

.PARAMETER Install
    安装/更新（幂等：已装则先删旧块，再按当前源码重新挂载）。

.PARAMETER Uninstall
    卸载（热卸载，删除本脚本加的块，保留其它插件/配置）。

.PARAMETER Verify
    验证：patch 是否合法、插件是否加载、凭证 loadedAt 是否够新、工具清单、日志关键字。

.PARAMETER Restore
    用最近一次 cordis.patch.yml.bak-* 覆盖当前 patch（覆盖前再备份当前文件）。

.PARAMETER Purge
    配合 -Uninstall：删除 loaded\index-*.js 哈希副本（默认保留，方便回滚/重装）。

.PARAMETER DryRun
    只展示将要写入的内容，不写任何文件。

.PARAMETER Profile
    DSH profile 名，默认 web（也可用 $env:DSH_PROFILE）。

.PARAMETER DshHome
    DSH Home，默认 $env:DSH_HOME，再默认 %APPDATA%\dsh-desktop\harness。

.PARAMETER PluginDir
    插件源码目录（含 index.js / package.json），默认本脚本上两级目录下的 dsh-plugin。

.PARAMETER Config
    覆盖插件 config 的哈希表，例如 @{ maxShown = 12; scope = 'global' }。

.PARAMETER YamlLib
    指定 js-yaml 的 index.js 路径；默认找 <profile>\node_modules\js-yaml\index.js。

.PARAMETER NodeExe
    指定 node 可执行文件；默认 PATH 里的 node，再默认 <DshHome>\.desktop-bin\node.cmd。

.PARAMETER NoValidate
    跳过 YAML 校验（不建议；只在确实拿不到 node/js-yaml 时用）。

.PARAMETER WaitSeconds
    安装后轮询 <DshHome>\session-bridge\.plugin-loaded.json 等待热加载的秒数，默认 15；0 = 不等。

.EXAMPLE
    .\安装到DSH.ps1 -Install
.EXAMPLE
    .\安装到DSH.ps1 -Install -Config @{ maxShown = 12; scope = 'global' }
.EXAMPLE
    .\安装到DSH.ps1 -Verify
.EXAMPLE
    .\安装到DSH.ps1 -Uninstall
.EXAMPLE
    .\安装到DSH.ps1 -Restore
.NOTES
    不需要管理员权限（只写用户目录 %APPDATA%\dsh-desktop\harness）。
    不会安装 npm 包、不联网、不改 DSH 本体、不重启 DSH。
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Verify,
    [switch]$Restore,
    [switch]$Purge,
    [switch]$DryRun,

    [Alias('Profile')]
    [string]$ProfileName = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }),
    [string]$DshHome = '',
    [string]$PluginDir = '',
    [hashtable]$Config = @{},
    [string]$YamlLib = '',
    [string]$NodeExe = '',
    [string]$FromBackup = '',
    [switch]$NoValidate,
    [int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
$BeginMarker = '# >>> session-bridge-local-install'
$EndMarker = '# <<< session-bridge-local-install'
$MarkerHint = '（由 安装到DSH.ps1 管理；整段删除即卸载）'

# 与 session-bridge\dsh-plugin\index.js 的 DEFAULT_CONFIG 对齐（index.js:38-59）
$DefaultConfig = [ordered]@{
    scope           = 'workspace'
    maxShown        = 8
    maxChars        = 460
    ttlHours        = 168
    handoffTtlHours = 72
    maxStored       = 80
    autoCapture     = $true
    instructions    = $true
    sectionOrder    = 650
    contextOrder    = 300
}
$ExpectedTools = @('session_share', 'session_board', 'session_ask', 'session_profile', 'session_nudge', 'group_rule', 'session_like', 'session_discuss', 'session_identity', 'group_skill', 'group_member', 'session_directory')

$ModeCount = 0
foreach ($modeSwitch in @($Install, $Uninstall, $Verify, $Restore)) {
    if ($modeSwitch.IsPresent) { $ModeCount++ }
}
if ($ModeCount -ne 1) {
    Write-Host '用法（必须且只能选一个模式）：' -ForegroundColor Yellow
    Write-Host '  .\安装到DSH.ps1 -Install     # 安装/更新（幂等，热生效）'
    Write-Host '  .\安装到DSH.ps1 -Verify      # 验证加载结果'
    Write-Host '  .\安装到DSH.ps1 -Uninstall   # 卸载（可加 -Purge 删哈希副本）'
    Write-Host '  .\安装到DSH.ps1 -Restore     # 用最近备份恢复 patch'
    Write-Host '  其它：-DryRun 只打印；-Profile web；-DshHome <path>；-Config @{...}'
    exit 2
}

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  !!  $Text" -ForegroundColor Yellow }
function Write-Err2([string]$Text) { Write-Host "  XX  $Text" -ForegroundColor Red }
function Write-Dim([string]$Text) { Write-Host "      $Text" -ForegroundColor DarkGray }

function Resolve-DshHomePath([string]$Explicit) {
    if ($Explicit -and $Explicit.Trim()) { return $Explicit.Trim() }
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { return $env:DSH_HOME.Trim() }
    return (Join-Path $env:APPDATA 'dsh-desktop\harness')
}

function Resolve-PluginDirPath([string]$Explicit) {
    if ($Explicit -and $Explicit.Trim()) { return $Explicit.Trim() }
    # 脚本就放在 session-bridge\ 下时，插件目录是同级的 dsh-plugin\；
    # 放在别处（例如调研目录）时兼容两层上级定位。
    $local = Join-Path $PSScriptRoot 'dsh-plugin'
    if (Test-Path -LiteralPath (Join-Path $local 'index.js') -PathType Leaf) { return $local }
    $sessionBridge = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    return (Join-Path $sessionBridge 'dsh-plugin')
}

function Read-TextFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-TextFileAtomic([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { throw "目录不存在：$dir" }
    $tmp = Join-Path $dir ('.tmp-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.yml')
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tmp, $Text, $utf8)
    $lastError = $null
    for ($i = 0; $i -lt 10; $i++) {
        try {
            Move-Item -LiteralPath $tmp -Destination $Path -Force
            $lastError = $null
            break
        } catch {
            $lastError = $_
            Start-Sleep -Milliseconds 250
        }
    }
    if ($lastError) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        throw "写入失败（可能被占用）：$Path -> $($lastError.Exception.Message)"
    }
    $back = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ($back -ne $Text) { throw "写入后回读不一致：$Path" }
}

function New-PatchBackup([string]$PatchPath) {
    if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) { return $null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = "$PatchPath.bak-$stamp"
    $n = 1
    while (Test-Path -LiteralPath $bak) {
        $bak = "$PatchPath.bak-$stamp-$n"
        $n++
    }
    Copy-Item -LiteralPath $PatchPath -Destination $bak -Force
    return $bak
}

function Get-NewestBackup([string]$PatchPath) {
    $parent = Split-Path -Parent $PatchPath
    $leaf = Split-Path -Leaf $PatchPath
    $items = @(Get-ChildItem -Path (Join-Path $parent ($leaf + '.bak-*')) -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    if ($items.Count -eq 0) { return $null }
    return $items[0].FullName
}

function ConvertTo-YamlScalar($Value) {
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
        return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0}', $Value)
    }
    $s = [string]$Value
    if ($s -match "[`r`n]") { throw "config 值不能包含换行：$s" }
    return "'" + ($s -replace "'", "''") + "'"
}

function Get-MergedConfigLines() {
    $merged = [ordered]@{}
    foreach ($key in $DefaultConfig.Keys) {
        if ($Config -and $Config.ContainsKey($key)) { $merged[$key] = $Config[$key] } else { $merged[$key] = $DefaultConfig[$key] }
    }
    if ($Config) {
        $extra = @($Config.Keys | Where-Object { -not $DefaultConfig.Contains($_) } | Sort-Object)
        foreach ($key in $extra) { $merged[$key] = $Config[$key] }
        $unknown = @($Config.Keys | Where-Object { -not $DefaultConfig.Contains($_) })
        if ($unknown.Count -gt 0) { Write-Warn2 ("config 里有插件默认配置之外的键：" + ($unknown -join ', ')) }
    }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($key in $merged.Keys) {
        $lines.Add('        ' + $key + ': ' + (ConvertTo-YamlScalar $merged[$key]))
    }
    return $lines.ToArray()
}

function Get-SourceHash([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $hash = $sha.ComputeHash($bytes)
        $hex = ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
        return $hex.Substring(0, 10)
    } finally {
        $sha.Dispose()
    }
}

function New-ManagedBlock([string]$Id, [string]$Name, [string[]]$ConfigLines) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($BeginMarker + $MarkerHint)
    $lines.Add('- insert:')
    $lines.Add('    - id: ' + $Id)
    $lines.Add("      name: '" + ($Name -replace "'", "''") + "'")
    $lines.Add('      config:')
    foreach ($line in $ConfigLines) { $lines.Add($line) }
    $lines.Add($EndMarker)
    return ($lines -join "`n")
}

function Read-PatchState([string]$Text) {
    $result = [ordered]@{
        Text             = ''
        Removed          = $false
        Unterminated     = $false
        HasMarker        = $false
        MeaningfulOthers = $false
    }
    if ($null -eq $Text) {
        $result.Text = ''
        return $result
    }
    $lines = $Text -split "`r?`n"
    $kept = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    $sawBegin = $false
    $sawEnd = $false
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if (-not $skipping) {
            if ($trim.StartsWith($BeginMarker)) { $skipping = $true; $sawBegin = $true; continue }
            $kept.Add($line)
        } else {
            if ($trim.StartsWith($EndMarker)) { $skipping = $false; $sawEnd = $true; continue }
        }
    }
    if ($sawBegin -and -not $sawEnd) { $result.Unterminated = $true }
    $result.Removed = $sawBegin
    $result.HasMarker = $sawBegin
    $result.Text = ($kept -join "`n").TrimEnd()
    foreach ($line in $kept) {
        $t = $line.Trim()
        if ($t.Length -gt 0 -and -not $t.StartsWith('#')) { $result.MeaningfulOthers = $true; break }
    }
    return $result
}

function Find-NodeExe([string]$Explicit, [string]$DshHomeArg) {
    if ($Explicit -and $Explicit.Trim()) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "找不到 -NodeExe：$Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bundled = Join-Path $DshHomeArg '.desktop-bin\node.cmd'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    return $null
}

function Find-YamlLib([string]$Explicit, [string]$DshHomeArg, [string]$ProfileDir2) {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Explicit -and $Explicit.Trim()) { $candidates.Add($Explicit.Trim()) }
    $candidates.Add((Join-Path $ProfileDir2 'node_modules\js-yaml\index.js'))
    $candidates.Add((Join-Path $DshHomeArg 'profiles\node_modules\js-yaml\index.js'))
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    return $null
}

$script:ValidatorSource = @'
const fs = require('node:fs')
const yaml = require(process.argv[2])
const patchPath = process.argv[3]
const expectId = process.argv[4] || ''
const expectName = process.argv[5] || ''
const JsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true })
const schema = yaml.DEFAULT_SCHEMA.extend([JsType])
let text
try { text = fs.readFileSync(patchPath, 'utf8') } catch (e) { console.error('YAML_READ_FAIL: ' + e.message); process.exit(3) }
let doc
try { doc = yaml.load(text, { schema }) } catch (e) { console.error('YAML_PARSE_FAIL: ' + (e && e.message ? e.message : e)); process.exit(3) }
if (!Array.isArray(doc)) { console.error('YAML_TOP_NOT_ARRAY: 顶层必须是数组（要禁用这一层请写 []）'); process.exit(3) }
const rows = []
for (const row of doc) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) { console.error('YAML_ROW_NOT_MAP: ' + JSON.stringify(row)); process.exit(3) }
  if (!Array.isArray(row.insert)) continue
  for (const item of row.insert) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { console.error('YAML_INSERT_NOT_MAP'); process.exit(3) }
    if (typeof item.id !== 'string' || item.id.length === 0) { console.error('YAML_INSERT_ID_MISSING: ' + JSON.stringify(item)); process.exit(3) }
    if (typeof item.name !== 'string' || item.name.length === 0) { console.error('YAML_INSERT_NAME_MISSING: ' + item.id); process.exit(3) }
    if (item.config !== undefined && (item.config === null || typeof item.config !== 'object' || Array.isArray(item.config))) {
      console.error('YAML_INSERT_CONFIG_NOT_MAP: ' + item.id); process.exit(3)
    }
    rows.push(item)
  }
}
const ids = rows.map((r) => r.id)
const dup = ids.filter((v, i) => ids.indexOf(v) !== i)
if (dup.length) { console.error('YAML_DUP_ID: ' + dup.join(',')); process.exit(3) }
if (expectId) {
  const hits = rows.filter((r) => r.id === expectId)
  if (hits.length !== 1) { console.error('YAML_EXPECT_ID_COUNT: ' + hits.length + ' for ' + expectId); process.exit(3) }
  if (expectName && hits[0].name !== expectName) { console.error('YAML_EXPECT_NAME_MISMATCH: ' + hits[0].name); process.exit(3) }
}
console.log('YAML_OK rows=' + rows.length)
process.exit(0)
'@

function Test-PatchText([string]$PatchText, [string]$ExpectId, [string]$ExpectName, [string]$Node, [string]$Yaml) {
    if ($NoValidate) { return @{ Ok = $true; Message = '已按 -NoValidate 跳过' } }
    if (-not $Node) { throw '找不到 node，无法校验 YAML；请用 -NodeExe 指定，或 -NoValidate 跳过（不建议）' }
    if (-not $Yaml) { throw '找不到 js-yaml（<profile>\node_modules\js-yaml\index.js）；请用 -YamlLib 指定，或 -NoValidate 跳过（不建议）' }
    $tmpPatch = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-patch-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.yml')
    $tmpScript = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-validate-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.cjs')
    try {
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($tmpPatch, $PatchText, $utf8)
        [System.IO.File]::WriteAllText($tmpScript, $script:ValidatorSource, $utf8)
        $output = & $Node $tmpScript $Yaml $tmpPatch $ExpectId $ExpectName 2>&1
        $code = $LASTEXITCODE
        $text = ($output | Out-String).Trim()
        if ($code -ne 0) { return @{ Ok = $false; Message = $text } }
        return @{ Ok = $true; Message = $text }
    } finally {
        Remove-Item -LiteralPath $tmpPatch -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
    }
}

function Get-PluginReceipt([string]$BoardDir) {
    $path = Join-Path $BoardDir '.plugin-loaded.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        return ($raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Wait-ForHotLoad([datetime]$SinceUtc, [int]$Seconds, [string]$BoardDir) {
    if ($Seconds -le 0) { return $null }
    $deadline = [datetime]::UtcNow.AddSeconds($Seconds)
    while ([datetime]::UtcNow -lt $deadline) {
        $receipt = Get-PluginReceipt $BoardDir
        if ($receipt -and $receipt.loadedAt) {
            try {
                $loaded = [datetimeoffset]::Parse([string]$receipt.loadedAt)
                if ($loaded.UtcDateTime -ge $SinceUtc.AddSeconds(-2)) { return $receipt }
            } catch { }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Show-PatchWarnings([object]$State) {
    if ($State.Unterminated) {
        Write-Warn2 'patch 里的开始标记没有配对的结束标记（可能上次写入被截断）；本次会按「删到文件末尾」处理，建议先看备份。'
    }
}

# ---------------------------------------------------------------------------
# 路径解析
# ---------------------------------------------------------------------------
$DshHome = Resolve-DshHomePath $DshHome
$PluginDir = Resolve-PluginDirPath $PluginDir
$ProfileName = $ProfileName.Trim()
if (-not $ProfileName) { $ProfileName = 'web' }
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$LoadedDir = Join-Path $PluginDir 'loaded'
$SourceFile = Join-Path $PluginDir 'index.js'
$BoardDir = Join-Path $DshHome 'session-bridge'
$ReceiptFile = Join-Path $BoardDir '.plugin-loaded.json'
$HarnessLog = Join-Path (Split-Path -Parent $DshHome) 'logs\harness.log'

Write-Step ('DSH Home   : ' + $DshHome)
Write-Dim ('profile    : ' + $ProfileDir)
Write-Dim ('patch      : ' + $PatchFile)
Write-Dim ('插件源码   : ' + $SourceFile)

if (-not (Test-Path -LiteralPath $ProfileDir -PathType Container)) {
    Write-Err2 "找不到 profile 目录：$ProfileDir"
    Write-Host '  如果 DSH 用的不是 web profile，加参数 -Profile <名字>。' -ForegroundColor Yellow
    exit 2
}

$Node = $null
$Yaml = $null
if (-not $NoValidate) {
    $Node = Find-NodeExe $NodeExe $DshHome
    $Yaml = Find-YamlLib $YamlLib $DshHome $ProfileDir
    if (-not $Node -or -not $Yaml) {
        Write-Err2 "YAML 校验器不可用（node=$Node, js-yaml=$Yaml）"
        Write-Dim '  可用 -NodeExe / -YamlLib 指定；确实拿不到再加 -NoValidate 跳过（不建议，写坏 patch 会导致下次启动失败）。'
        exit 2
    }
}

# ---------------------------------------------------------------------------
# 模式实现
# ---------------------------------------------------------------------------
$rollingBack = $false
$backupPath = $null
$newLoadedPath = $null

try {
    if ($Install) {
        Write-Step '安装 / 更新插件'
        if (-not (Test-Path -LiteralPath $SourceFile -PathType Leaf)) { throw "找不到插件入口：$SourceFile" }
        $pkgFile = Join-Path $PluginDir 'package.json'
        if (Test-Path -LiteralPath $pkgFile -PathType Leaf) {
            try {
                $pkg = [System.IO.File]::ReadAllText($pkgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                if ([string]$pkg.type -ne 'module') {
                    Write-Warn2 ('package.json 的 type 不是 module（当前：' + [string]$pkg.type + '）；Node 24 通常仍能按语法检测加载，但建议改成 "type": "module"。')
                }
            } catch {
                Write-Warn2 "package.json 解析失败，忽略：$($_.Exception.Message)"
            }
        } else {
            Write-Warn2 '插件目录没有 package.json；建议补一个 {"type":"module"}（不是必须，但更稳）。'
        }

        # 0) 旧 patch 状态
        $oldText = Read-TextFile $PatchFile
        if ($null -eq $oldText) {
            Write-Warn2 '当前没有 cordis.patch.yml，将新建（顶层只放本插件块）。'
            $oldText = ''
        }
        $oldState = Read-PatchState $oldText
        Show-PatchWarnings $oldState
        if ($oldState.HasMarker) { Write-Dim '检测到已有本插件块 → 先移除旧块，再按当前源码重装（幂等）。' }

        # 1) 计算哈希 + 新入口
        $hash = Get-SourceHash $SourceFile
        $loadedName = "index-$hash.js"
        $newLoadedPath = Join-Path $LoadedDir $loadedName
        Write-Dim "内容哈希 SHA-256 前 10 位：$hash"
        Write-Dim "新入口：$newLoadedPath"

        # 2) 新块（配置 + 绝对路径 + 带哈希 id）
        $configLines = Get-MergedConfigLines
        $id = "session-bridge-$hash"
        $block = New-ManagedBlock $id $newLoadedPath $configLines

        $stripped = $oldState.Text
        $candidate = $block
        if ($stripped -and $stripped.Trim().Length -gt 0) {
            $candidate = $stripped.TrimEnd() + "`n" + $block
        }
        $candidate = $candidate.TrimEnd() + "`n"

        Write-Step '预览新的 patch 块'
        Write-Host $block -ForegroundColor DarkGray

        if ($DryRun) {
            Write-Step 'DRY RUN：不写任何文件'
            Write-Host '--- 合并后的 cordis.patch.yml 将如下 ---' -ForegroundColor DarkGray
            Write-Host $candidate -ForegroundColor DarkGray
            exit 0
        }

        # 3) 先校验，再写
        Write-Step '校验合并后的 YAML（js-yaml，兼容 !!js）'
        $check = Test-PatchText $candidate $id $newLoadedPath $Node $Yaml
        if (-not $check.Ok) {
            Write-Err2 'YAML 校验没通过，已放弃写入（没有动你的配置文件）：'
            Write-Host ('  ' + $check.Message) -ForegroundColor Red
            exit 2
        }
        Write-Ok $check.Message

        # 4) 写新哈希副本（不碰旧文件）
        if (-not (Test-Path -LiteralPath $LoadedDir -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $LoadedDir | Out-Null
        }
        $sourceBytes = [System.IO.File]::ReadAllBytes($SourceFile)
        $tmpLoaded = Join-Path $LoadedDir ('.tmp-' + $hash + '.js')
        [System.IO.File]::WriteAllBytes($tmpLoaded, $sourceBytes)
        Move-Item -LiteralPath $tmpLoaded -Destination $newLoadedPath -Force
        Write-Ok "已复制插件入口：$loadedName"

        # 5) 备份 + 原子写 patch
        $backupPath = New-PatchBackup $PatchFile
        if ($backupPath) { Write-Ok "已备份：$backupPath" } else { Write-Dim '（原本没有 patch 文件，无需备份）' }

        Write-Step '写入 cordis.patch.yml'
        Write-TextFileAtomic $PatchFile $candidate
        Write-Ok "已写入：$PatchFile"

        # 6) 清理更早的哈希副本（保留旧 patch 引用的 + 新文件）
        $keep = @{}
        $keep[$loadedName] = $true
        $patterns = @($oldText, $candidate)
        foreach ($t in $patterns) {
            if (-not $t) { continue }
            foreach ($m in [regex]::Matches($t, 'index-([0-9a-f]{10})\.js')) { $keep[('index-' + $m.Groups[1].Value + '.js')] = $true }
        }
        foreach ($f in @(Get-ChildItem -LiteralPath $LoadedDir -Filter 'index-*.js' -File -ErrorAction SilentlyContinue)) {
            if (-not $keep.ContainsKey($f.Name)) {
                Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
                Write-Dim "已清理旧副本：$($f.Name)"
            }
        }

        # 7) 等热加载
        Write-Step '等待 DSH 热重组并加载插件（改 patch 后约 1~3 秒）'
        $receipt = Wait-ForHotLoad ([datetime]::UtcNow) $WaitSeconds $BoardDir
        if ($receipt) {
            Write-Ok "热加载成功：loadedAt=$($receipt.loadedAt)  version=$($receipt.version)"
            if ($receipt.tools) { Write-Dim ('工具：' + (@($receipt.tools) -join ', ')) }
        } else {
            Write-Warn2 "在 $WaitSeconds 秒内没有看到新的 .plugin-loaded.json（宿主可能还没重组完，或注入服务缺失）。"
            Write-Dim '  稍后运行 .\安装到DSH.ps1 -Verify 再看；仍没有就看日志：'
            Write-Dim ('  ' + $HarnessLog)
            Write-Dim '  兜底：标题栏菜单「重启」/ Ctrl+Shift+R 重启 Harness。'
        }

        Write-Host ''
        Write-Ok '安装完成。'
        Write-Host '  下一步：' -ForegroundColor Green
        Write-Host '   1) 新开一个会话，验证能用 session_share / session_board。'
        Write-Host '   2) 设置 → 插件 里应能看到 id 以 session-bridge- 开头、阶段为 active 的条目。'
        Write-Host '   3) 验证：.\安装到DSH.ps1 -Verify'
        Write-Host '   4) 卸载：.\安装到DSH.ps1 -Uninstall'
        exit 0
    }

    if ($Uninstall) {
        Write-Step '卸载插件'
        $oldText = Read-TextFile $PatchFile
        if ($null -eq $oldText) {
            Write-Ok '没有 cordis.patch.yml，本来就没装。'
            exit 0
        }
        $state = Read-PatchState $oldText
        if (-not $state.HasMarker) {
            Write-Ok 'patch 里没有本插件的块，本来就没装（或已手动删过）。'
            if ($Purge -and (Test-Path -LiteralPath $LoadedDir)) {
                Get-ChildItem -LiteralPath $LoadedDir -Filter 'index-*.js' -File -ErrorAction SilentlyContinue | Remove-Item -Force
                Write-Dim '已清理 loaded\index-*.js'
            }
            exit 0
        }
        Show-PatchWarnings $state
        $newText = $state.Text
        if (-not $state.MeaningfulOthers) {
            # 删完只剩注释/空白 → 必须写成 []，否则空/纯注释 patch 会导致下次启动失败
            $newText = '[]'
            Write-Dim '删除后没有其它配置行 → 写成 []（空 patch 会启动失败）。'
        }
        $newText = $newText.TrimEnd() + "`n"

        Write-Step '预览卸载后的 cordis.patch.yml'
        Write-Host $newText -ForegroundColor DarkGray
        if ($DryRun) { Write-Step 'DRY RUN：不写任何文件'; exit 0 }

        $check = Test-PatchText $newText '' '' $Node $Yaml
        if (-not $check.Ok) {
            Write-Err2 '卸载后的 YAML 校验没过，已放弃写入：'
            Write-Host ('  ' + $check.Message) -ForegroundColor Red
            exit 2
        }
        Write-Ok $check.Message

        $backupPath = New-PatchBackup $PatchFile
        if ($backupPath) { Write-Ok "已备份：$backupPath" }
        Write-TextFileAtomic $PatchFile $newText
        Write-Ok "已写入：$PatchFile"

        if ($Purge -and (Test-Path -LiteralPath $LoadedDir -PathType Container)) {
            Get-ChildItem -LiteralPath $LoadedDir -Filter 'index-*.js' -File -ErrorAction SilentlyContinue | Remove-Item -Force
            Write-Ok '已清理 loaded\index-*.js'
        }

        Write-Step '等待热卸载（约 1~3 秒）'
        Start-Sleep -Seconds 2
        Write-Ok '卸载完成：DSH 会在下次重组合时移除该条目并 dispose 插件（工具/提示词段随之注销）。'
        Write-Dim '确认：设置 → 插件 里该条目消失；新会话不再有 session_share/session_board。'
        Write-Dim '插件自己写在 <DSH_HOME>\session-bridge\ 的看板数据不会被删（需要的话手动删目录）。'
        exit 0
    }

    if ($Verify) {
        Write-Step '验证插件'
        $fail = 0
        $oldText = Read-TextFile $PatchFile
        if ($null -eq $oldText) {
            Write-Err2 "没有 cordis.patch.yml：$PatchFile"
            exit 1
        }
        $state = Read-PatchState $oldText
        if (-not $state.HasMarker) {
            Write-Err2 'patch 里没有本插件的块（没装）。'
            $fail++
        } else {
            $idMatch = [regex]::Match($oldText, 'session-bridge-([0-9a-f]{10})')
            if ($idMatch.Success) {
                $hash = $idMatch.Groups[1].Value
                $loadedPath = Join-Path $LoadedDir "index-$hash.js"
                Write-Ok "patch 中条目 id：session-bridge-$hash"
                if (Test-Path -LiteralPath $loadedPath -PathType Leaf) {
                    Write-Ok "入口文件存在：$loadedPath"
                } else {
                    Write-Err2 "入口文件不存在：$loadedPath（插件会 import 失败，日志里是警告）"
                    $fail++
                }
                $check = Test-PatchText $oldText ("session-bridge-$hash") $loadedPath $Node $Yaml
                if ($check.Ok) { Write-Ok $check.Message } else { Write-Err2 ('YAML 校验失败：' + $check.Message); $fail++ }
            } else {
                Write-Warn2 'patch 有块但没认出哈希 id（可能是旧格式）。'
            }
        }

        $receipt = Get-PluginReceipt $BoardDir
        if (-not $receipt) {
            Write-Warn2 "没有加载凭证：$ReceiptFile"
            Write-Dim '  说明宿主还没成功 apply 该插件（没装 / 还在重组合 / import 失败 / 注入服务缺失）。'
            $fail++
        } else {
            Write-Ok "凭证：loadedAt=$($receipt.loadedAt)  plugin=$($receipt.plugin)  version=$($receipt.version)  hostPid=$($receipt.hostPid)"
            $tools = @($receipt.tools)
            Write-Dim ('工具：' + $(if ($tools.Count -gt 0) { $tools -join ', ' } else { '(无)' }))
            foreach ($t in $ExpectedTools) {
                if ($tools -contains $t) { Write-Ok "工具已注册：$t" } else { Write-Warn2 "工具未注册：$t"; $fail++ }
            }
            if ($receipt.registration) {
                Write-Dim ("registration.section=$($receipt.registration.section)  context=$($receipt.registration.context)")
            }
            if (Test-Path -LiteralPath $PatchFile -PathType Leaf) {
                try {
                    $patchTime = (Get-Item -LiteralPath $PatchFile).LastWriteTimeUtc
                    $loadedTime = [datetimeoffset]::Parse([string]$receipt.loadedAt).UtcDateTime
                    if ($loadedTime -lt $patchTime.AddSeconds(-3)) {
                        Write-Warn2 '凭证比 patch 旧：可能还没热加载完成（等 2~3 秒再 -Verify，或菜单重启 Harness）。'
                    }
                } catch { }
            }
        }

        $boardLog = Join-Path $BoardDir 'session-bridge.log'
        if (Test-Path -LiteralPath $boardLog -PathType Leaf) {
            Write-Step '插件自己的日志（末尾 6 行）'
            Get-Content -LiteralPath $boardLog -Tail 6 | ForEach-Object { Write-Dim $_ }
        }

        if (Test-Path -LiteralPath $HarnessLog -PathType Leaf) {
            Write-Step 'Harness 日志里的相关内容（末尾 800 行的匹配）'
            $patterns = 'session-bridge', 'plugin failures:', 'plugin tree failed to load', 'failed to apply', 'failed to import loader entry', 'does not provide an export named', '\[harness-log\] error'
            $hits = @(Get-Content -LiteralPath $HarnessLog -Tail 800 -ErrorAction SilentlyContinue |
                Select-String -Pattern $patterns -ErrorAction SilentlyContinue)
            if ($hits.Count -eq 0) {
                Write-Ok '没有匹配到错误/插件加载失败关键字。'
            } else {
                $hits | Select-Object -Last 10 | ForEach-Object { Write-Dim $_.Line }
            }
        } else {
            Write-Dim "（没有找到 Harness 日志：$HarnessLog）"
        }

        Write-Host ''
        Write-Host 'GUI 复核：' -ForegroundColor Green
        Write-Host '  * 设置 → 插件：找 id 以 session-bridge- 开头的行，fiber 阶段应为 active。'
        Write-Host '  * 新会话：让模型调用 session_board（或 session_share）。'
        Write-Host '  * 标题栏菜单「显示 Harness 日志」可直接打开日志。'

        if ($fail -gt 0) {
            Write-Err2 "验证未通过（$fail 项）。先看上面的提示/日志，或 .\安装到DSH.ps1 -Uninstall 回滚。"
            exit 1
        }
        Write-Ok '验证通过。'
        exit 0
    }

    if ($Restore) {
        Write-Step '从备份恢复 cordis.patch.yml'
        $source = $FromBackup
        if (-not $source -or -not $source.Trim()) { $source = Get-NewestBackup $PatchFile }
        if (-not $source -or -not (Test-Path -LiteralPath $source -PathType Leaf)) {
            Write-Err2 "没有可用的备份（$PatchFile.bak-*）"
            exit 2
        }
        $restoredText = Read-TextFile $source
        if ($null -eq $restoredText) { Write-Err2 "备份读不出来：$source"; exit 2 }
        $check = Test-PatchText $restoredText '' '' $Node $Yaml
        if (-not $check.Ok) {
            Write-Err2 '备份本身的 YAML 校验没过，拒绝恢复（先人工检查这个备份）：'
            Write-Host ('  ' + $check.Message) -ForegroundColor Red
            exit 2
        }
        Write-Ok "将恢复：$source"
        Write-Dim "内容预览（前 20 行）："
        ($restoredText -split "`r?`n" | Select-Object -First 20) | ForEach-Object { Write-Dim $_ }
        if ($DryRun) { Write-Step 'DRY RUN：不写任何文件'; exit 0 }
        $currentBackup = New-PatchBackup $PatchFile
        if ($currentBackup) { Write-Ok "当前文件已再备份：$currentBackup" }
        Write-TextFileAtomic $PatchFile ($restoredText.TrimEnd() + "`n")
        Write-Ok "已恢复：$PatchFile"
        Write-Step '等 2~3 秒热重组；如不放心，标题栏菜单「重启」/ Ctrl+Shift+R。'
        exit 0
    }
} catch {
    $err = $_
    Write-Err2 ("失败：" + $err.Exception.Message)
    if ($Install -and -not $DryRun) {
        Write-Step '尝试自动回滚'
        $ok = $true
        try {
            if ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
                Copy-Item -LiteralPath $backupPath -Destination $PatchFile -Force
                Write-Ok "已从备份恢复 patch：$backupPath"
            } elseif ($backupPath -eq $null -and -not (Test-Path -LiteralPath $PatchFile)) {
                Write-Dim '（patch 原本不存在，无需恢复）'
            }
        } catch { $ok = $false; Write-Err2 ("恢复 patch 失败：" + $_.Exception.Message) }
        try {
            if ($newLoadedPath -and (Test-Path -LiteralPath $newLoadedPath)) { Remove-Item -LiteralPath $newLoadedPath -Force }
        } catch { $ok = $false }
        if ($ok) { Write-Warn2 '已回滚到安装前状态。' }
        else { Write-Err2 ("自动回滚不完整，请手动用备份恢复：" + $backupPath) }
    }
    exit 3
}
