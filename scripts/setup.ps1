param([string]$Distribution = 'Ubuntu', [string]$StateDir = '', [switch]$SkipBuild)
& "$PSScriptRoot/invoke-runtime.ps1" -Action setup -Distribution $Distribution -StateDir $StateDir -SkipBuild:$SkipBuild
