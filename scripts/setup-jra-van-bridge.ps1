[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$EnvironmentPath = Join-Path $RepositoryRoot '.local\jra-van-bridge-venv'
$EnvironmentPython = Join-Path $EnvironmentPath 'Scripts\python.exe'
$Requirements = Join-Path $RepositoryRoot 'tools\jra_van_bridge\requirements-jvlink.txt'

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw 'Python launcher was not found. Install Python 3.14 (64bit).'
}

$Runtime = & py -3.14 -c "import struct,sys; print(f'{sys.version_info.major}.{sys.version_info.minor}:{struct.calcsize(chr(80))*8}')"
if ($LASTEXITCODE -ne 0 -or $Runtime -ne '3.14:64') {
  throw 'Python 3.14 (64bit) is required.'
}

if (-not (Test-Path -LiteralPath $EnvironmentPython)) {
  & py -3.14 -m venv $EnvironmentPath
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create the local bridge environment.' }
}

& $EnvironmentPython -m pip install --disable-pip-version-check --require-hashes --requirement $Requirements
if ($LASTEXITCODE -ne 0) { throw 'Failed to install the pinned bridge dependency.' }

& $EnvironmentPython -c "import struct, win32com.client; print('JRA-VAN bridge dependency ready: Python 3.14 / 64bit / pywin32')"
if ($LASTEXITCODE -ne 0) { throw 'The local bridge dependency check failed.' }
