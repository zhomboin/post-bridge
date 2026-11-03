param([string]$Distribution = 'Ubuntu', [string]$StateDir = '', [switch]$SkipBuild)
& "$PSScriptRoot/invoke-runtime.ps1" -Action stop -Distribution $Distribution -StateDir $StateDir -SkipBuild:$SkipBuild
