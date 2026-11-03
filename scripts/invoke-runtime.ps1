param([Parameter(Mandatory)][string]$Action, [string]$Distribution = 'Ubuntu', [string]$StateDir = '', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
if ($repository -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
    $Distribution = $Matches[1]
    $linuxRepository = '/' + $Matches[2].Replace('\', '/')
} else {
    $linuxRepository = (& wsl.exe -d $Distribution -- wslpath -a $repository).Trim()
    if ($LASTEXITCODE -ne 0) { throw '无法取得 WSL 项目路径' }
}
$runtimeArguments = @('-d', $Distribution, '--cd', $linuxRepository, '--', 'python3', "$linuxRepository/scripts/runtime.py", $Action)
if ($StateDir) { $runtimeArguments += @('--state', $StateDir) }
if ($SkipBuild) { $runtimeArguments += '--skip-build' }
& wsl.exe @runtimeArguments
if ($LASTEXITCODE -ne 0) { throw 'Post Bridge 操作失败，请检查本地工具和私有日志' }