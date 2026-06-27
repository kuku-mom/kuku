param(
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$DesktopDir = Join-Path $RepoRoot "apps\desktop"
$TauriConfig = Join-Path $DesktopDir "src-tauri\tauri.conf.json"
$BundleDir = Join-Path $RepoRoot "target\release\bundle"

if ([System.IO.Path]::DirectorySeparatorChar -ne '\') {
  throw "Windows release bundles must be built on Windows."
}

function Read-DesktopVersion {
  $config = Get-Content $TauriConfig -Raw | ConvertFrom-Json
  return $config.version
}

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Assert-WindowsNativeBuildTools {
  $hasCompilerInPath = (Get-Command "cl" -ErrorAction SilentlyContinue) -or (Get-Command "link" -ErrorAction SilentlyContinue)
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  $hasVisualStudioTools = $false

  if (Test-Path $vswhere) {
    $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $hasVisualStudioTools = -not [string]::IsNullOrWhiteSpace($installationPath)
  }

  if (-not $hasCompilerInPath -and -not $hasVisualStudioTools) {
    throw "Microsoft C++ Build Tools were not found. Run scripts\setup-windows-build-prereqs.ps1 to audit this machine, or install Visual Studio Build Tools with the 'Desktop development with C++' workload before building Windows installers."
  }
}

function Enter-WindowsNativeBuildEnvironment {
  if ((Get-Command "link" -ErrorAction SilentlyContinue) -and (Get-Command "cl" -ErrorAction SilentlyContinue)) {
    return
  }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    return
  }

  $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ([string]::IsNullOrWhiteSpace($installationPath)) {
    return
  }

  $vcVars = Join-Path $installationPath "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcVars)) {
    throw "Visual Studio Build Tools were found, but vcvars64.bat was missing at $vcVars."
  }

  $environment = cmd /c "`"$vcVars`" >nul && set"
  foreach ($line in $environment) {
    $index = $line.IndexOf("=")
    if ($index -le 0) {
      continue
    }

    $name = $line.Substring(0, $index)
    $value = $line.Substring($index + 1)
    Set-Item -Path "Env:$name" -Value $value
  }
}

function Copy-IfExists($Pattern, $Destination) {
  $matches = Get-ChildItem -Path $Pattern -ErrorAction SilentlyContinue
  foreach ($item in $matches) {
    Copy-Item -LiteralPath $item.FullName -Destination $Destination -Force
  }
}

Set-Location $RepoRoot

Assert-Command "pnpm"
Assert-Command "cargo"
Assert-WindowsNativeBuildTools
Enter-WindowsNativeBuildEnvironment

$version = Read-DesktopVersion
$OutDir = Join-Path $RepoRoot "release-artifacts\windows\$version"
$BundleOutDir = Join-Path $OutDir "github"

New-Item -ItemType Directory -Force -Path $BundleOutDir | Out-Null

if (-not $SkipChecks) {
  pnpm --filter "@kuku/desktop" build
  cargo check --locked -p kuku-app --all-targets
}

pnpm --filter "@kuku/desktop" tauri:build:windows

Copy-IfExists (Join-Path $BundleDir "nsis\*.exe") $BundleOutDir
Copy-IfExists (Join-Path $BundleDir "msi\*.msi") $BundleOutDir
Copy-IfExists (Join-Path $BundleDir "nsis\*.sig") $BundleOutDir
Copy-IfExists (Join-Path $BundleDir "msi\*.sig") $BundleOutDir

$nsisInstallers = Get-ChildItem -Path (Join-Path $BundleOutDir "*.exe") -File -ErrorAction SilentlyContinue
$msiInstallers = Get-ChildItem -Path (Join-Path $BundleOutDir "*.msi") -File -ErrorAction SilentlyContinue

if (-not $nsisInstallers) {
  throw "No NSIS .exe installer was found under $BundleDir."
}

if (-not $msiInstallers) {
  throw "No MSI .msi installer was found under $BundleDir."
}

@"
# Kuku Windows $version

Artifacts in this folder were produced by:

    .\scripts\release-windows.ps1

Upload the `.exe` and `.msi` installers to the GitHub release for $version.
"@ | Set-Content -Path (Join-Path $OutDir "README.md") -Encoding UTF8

Write-Host "Windows release artifacts written to $OutDir"
