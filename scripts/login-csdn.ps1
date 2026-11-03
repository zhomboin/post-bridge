param([string]$Distribution = 'Ubuntu', [string]$StateDir = '')
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
if ($repository -match '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$') {
    $Distribution = $Matches[1]
    $linuxRepository = '/' + $Matches[2].Replace('\', '/')
} else {
    $linuxRepository = (& wsl.exe -d $Distribution -- wslpath -a $repository).Trim()
    if ($LASTEXITCODE -ne 0) { throw '无法取得 WSL 项目路径' }
}
$launcher = Join-Path $env:ProgramFiles 'WSL/wslg.exe'
if (-not (Test-Path -LiteralPath $launcher)) { throw '需要支持 WSLg 的 Ubuntu 图形环境' }
$arguments = @('--distribution', $Distribution, '--', 'python3', "$linuxRepository/scripts/runtime.py", 'login')
if ($StateDir) { $arguments += @('--state', $StateDir) }
& $launcher @arguments
if ($LASTEXITCODE -ne 0) { throw 'CSDN 登录助手未完成' }