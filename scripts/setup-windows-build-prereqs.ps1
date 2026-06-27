param(
  [switch]$Install,
  [switch]$SkipNode,
  [switch]$SkipGo,
  [switch]$SkipRust,
  [switch]$SkipVisualStudio
)

$ErrorActionPreference = "Stop"

if ([System.IO.Path]::DirectorySeparatorChar -ne '\') {
  throw "Windows build prerequisites must be checked on Windows."
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-Command($Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-PathIfExists($Path) {
  if ((Test-Path $Path) -and ($env:Path -notlike "*$Path*")) {
    $env:Path = "$Path;$env:Path"
  }
}

function Refresh-ToolPaths {
  Add-PathIfExists (Join-Path $env:USERPROFILE ".cargo\bin")
  Add-PathIfExists (Join-Path $env:ProgramFiles "nodejs")
  Add-PathIfExists (Join-Path $env:ProgramFiles "Go\bin")
}

function Test-VisualStudioBuildTools {
  $hasCompilerInPath = (Test-Command "cl") -or (Test-Command "link")
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"

  if ($hasCompilerInPath) {
    return $true
  }

  if (Test-Path $vswhere) {
    $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    return -not [string]::IsNullOrWhiteSpace($installationPath)
  }

  return $false
}

function Install-WingetPackage($Id, $Name, $ExtraArgs = @()) {
  if (-not (Test-Command "winget")) {
    throw "winget was not found. Install 'App Installer' from Microsoft Store, then reopen Administrator PowerShell and rerun this script. If Microsoft Store is unavailable, install prerequisites manually: Node.js LTS from https://nodejs.org/, Go from https://go.dev/dl/, and Visual Studio Build Tools from https://visualstudio.microsoft.com/downloads/ with the 'Desktop development with C++' workload."
  }

  Write-Host "Installing $Name..."
  winget install --id $Id --exact --accept-package-agreements --accept-source-agreements @ExtraArgs
}

function Enable-Pnpm {
  if (-not (Test-Command "node")) {
    throw "Node.js is required before pnpm can be enabled."
  }

  if (Test-Command "corepack") {
    corepack enable
    corepack prepare pnpm@11.1.1 --activate
  } elseif (Test-Command "pnpm") {
    return
  } elseif (Test-Command "npm.cmd") {
    npm.cmd install --global pnpm@11.1.1
  } elseif (Test-Command "npm") {
    npm install --global pnpm@11.1.1
  } else {
    throw "corepack, pnpm, and npm were not found. Install pnpm 11.1.1 manually or use a Node.js distribution that includes corepack."
  }
}

$isAdmin = Test-IsAdmin
Refresh-ToolPaths

$status = [ordered]@{
  Admin = $isAdmin
  Node = Test-Command "node"
  Pnpm = Test-Command "pnpm"
  Go = Test-Command "go"
  Cargo = Test-Command "cargo"
  Rustc = Test-Command "rustc"
  VisualStudioBuildTools = Test-VisualStudioBuildTools
}

Write-Host "Windows build prerequisite status:"
foreach ($item in $status.GetEnumerator()) {
  Write-Host ("  {0}: {1}" -f $item.Key, $item.Value)
}

if (-not $Install) {
  $missing = @()
  if (-not $SkipNode -and (-not $status.Node -or -not $status.Pnpm)) { $missing += "Node.js + pnpm" }
  if (-not $SkipGo -and -not $status.Go) { $missing += "Go" }
  if (-not $SkipRust -and (-not $status.Cargo -or -not $status.Rustc)) { $missing += "Rust" }
  if (-not $SkipVisualStudio -and -not $status.VisualStudioBuildTools) { $missing += "Visual Studio Build Tools" }

  if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Missing prerequisites: $($missing -join ', ')"
    Write-Host "Run from an Administrator PowerShell with -Install to install supported prerequisites via winget."
    exit 1
  }

  Write-Host "All requested Windows build prerequisites are available."
  exit 0
}

if (-not $isAdmin) {
  throw "Run this script from an Administrator PowerShell when using -Install."
}

if (-not $SkipNode -and -not $status.Node) {
  Install-WingetPackage "OpenJS.NodeJS" "Node.js"
  Refresh-ToolPaths
}

if (-not $SkipGo -and -not $status.Go) {
  Install-WingetPackage "GoLang.Go" "Go"
  Refresh-ToolPaths
}

if (-not $SkipRust -and (-not $status.Cargo -or -not $status.Rustc)) {
  Install-WingetPackage "Rustlang.Rustup" "Rustup"
  Refresh-ToolPaths
  rustup toolchain install stable --profile minimal
  rustup default stable
}

if (-not $SkipVisualStudio -and -not $status.VisualStudioBuildTools) {
  Install-WingetPackage "Microsoft.VisualStudio.2022.BuildTools" "Visual Studio Build Tools" @(
    "--override",
    "--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  )
}

if (-not $SkipNode) {
  Enable-Pnpm
}

Write-Host ""
Write-Host "Prerequisite installation finished. Open a new PowerShell session, then run:"
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-windows.ps1"
