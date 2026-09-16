[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $BridgeArguments
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Python = $null
$EnvironmentPython = Join-Path $RepositoryRoot '.local\jra-van-bridge-venv\Scripts\python.exe'

if (Test-Path -LiteralPath $EnvironmentPython) {
  $Python = @($EnvironmentPython)
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $Python = @('py', '-3.14')
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $Python = @('python')
} else {
  throw 'Python 3.14 (64bit) was not found. Install the runtime used by the JRA-VAN SDK 5.0.0 sample.'
}

Push-Location $RepositoryRoot
try {
  if ($Python.Count -eq 2) {
    & $Python[0] $Python[1] -m tools.jra_van_bridge @BridgeArguments
  } else {
    & $Python[0] -m tools.jra_van_bridge @BridgeArguments
  }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
