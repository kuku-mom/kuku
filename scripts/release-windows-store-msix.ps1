param(
  [string]$PackageIdentityName = "Kuku.Kuku",
  [string]$Publisher = "CN=kuku",
  [string]$PublisherDisplayName = "kuku",
  [string]$Version,
  [switch]$SkipBuild,
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$DesktopDir = Join-Path $RepoRoot "apps\desktop"
$TauriDir = Join-Path $DesktopDir "src-tauri"
$ManifestTemplate = Join-Path $TauriDir "windows\AppxManifest.xml"
$WindowsIcon = Join-Path $TauriDir "icons\windows\icon.png"

function Get-JsonValue([string]$Path, [string]$Key) {
  $json = Get-Content -Raw -Path $Path | ConvertFrom-Json
  return $json.$Key
}

function Find-WindowsSdkTool([string]$ToolName) {
  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "$env:ProgramFiles\Windows Kits\10\bin"
  )

  foreach ($root in $roots) {
    if (-not (Test-Path $root)) {
      continue
    }

    $tool = Get-ChildItem -Path $root -Recurse -Filter $ToolName -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\x64\\$([regex]::Escape($ToolName))$" } |
      Sort-Object FullName -Descending |
      Select-Object -First 1

    if ($tool) {
      return $tool.FullName
    }
  }

  return $null
}

if (-not $Version) {
  $Version = Get-JsonValue -Path (Join-Path $TauriDir "tauri.conf.json") -Key "version"
}

if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  $Version = "$Version.0"
}

$MakeAppx = Find-WindowsSdkTool "MakeAppx.exe"
if (-not $MakeAppx) {
  throw "MakeAppx.exe was not found. Install the Windows SDK, then rerun this script."
}

if (-not (Test-Path $ManifestTemplate)) {
  throw "MSIX manifest template was not found: $ManifestTemplate"
}

if (-not (Test-Path $WindowsIcon)) {
  throw "Windows icon source was not found: $WindowsIcon"
}

if (-not $SkipBuild) {
  $releaseScript = Join-Path $RepoRoot "scripts\release-windows.ps1"
  if (-not (Test-Path $releaseScript)) {
    throw "Windows release script was not found: $releaseScript"
  }

  $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $releaseScript)
  if ($SkipChecks) {
    $args += "-SkipChecks"
  }

  & powershell @args
}

$ExePath = Join-Path $RepoRoot "target\release\kuku-app.exe"
if (-not (Test-Path $ExePath)) {
  throw "Built desktop executable was not found: $ExePath"
}

$OutDir = Join-Path $RepoRoot "release-artifacts\windows\store\$Version"
$StageDir = Join-Path $OutDir "stage"
$PackagePath = Join-Path $OutDir "Kuku_$($Version)_x64_store.msix"

Remove-Item -Recurse -Force -LiteralPath $StageDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "Assets") | Out-Null

Copy-Item -LiteralPath $ExePath -Destination (Join-Path $StageDir "kuku-app.exe")
Copy-Item -LiteralPath (Join-Path $TauriDir "icons\windows\icon.ico") -Destination (Join-Path $StageDir "icon.ico")

Add-Type -AssemblyName System.Drawing

function New-SquareAsset([string]$Path, [int]$Size, [string]$Background = "Transparent") {
  $source = [System.Drawing.Image]::FromFile($WindowsIcon)
  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  if ($Background -ne "Transparent") {
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml($Background))
  } else {
    $graphics.Clear([System.Drawing.Color]::Transparent)
  }
  $logoSize = [Math]::Round($Size * 0.78)
  $offset = [Math]::Round(($Size - $logoSize) / 2)
  $graphics.DrawImage($source, $offset, $offset, $logoSize, $logoSize)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  $source.Dispose()
}

function New-WideAsset([string]$Path) {
  $source = [System.Drawing.Image]::FromFile($WindowsIcon)
  $bitmap = New-Object System.Drawing.Bitmap(310, 150, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawImage($source, 18, 18, 114, 114)
  $font = New-Object System.Drawing.Font("Segoe UI", 34, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(18, 18, 18))
  $graphics.DrawString("Kuku", $font, $brush, 146, 52)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $brush.Dispose()
  $font.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  $source.Dispose()
}

New-SquareAsset -Path (Join-Path $StageDir "Assets\Square44x44Logo.png") -Size 44
New-SquareAsset -Path (Join-Path $StageDir "Assets\Square150x150Logo.png") -Size 150
New-SquareAsset -Path (Join-Path $StageDir "Assets\Square310x310Logo.png") -Size 310
New-SquareAsset -Path (Join-Path $StageDir "Assets\StoreLogo.png") -Size 300 -Background "#ffffff"
New-WideAsset -Path (Join-Path $StageDir "Assets\Wide310x150Logo.png")

$manifest = Get-Content -Raw -Path $ManifestTemplate
$manifest = $manifest.Replace("{{PACKAGE_IDENTITY_NAME}}", $PackageIdentityName)
$manifest = $manifest.Replace("{{PUBLISHER}}", $Publisher)
$manifest = $manifest.Replace("{{PUBLISHER_DISPLAY_NAME}}", $PublisherDisplayName)
$manifest = $manifest.Replace("{{VERSION}}", $Version)
Set-Content -Path (Join-Path $StageDir "AppxManifest.xml") -Value $manifest -Encoding utf8

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Remove-Item -Force -LiteralPath $PackagePath -ErrorAction SilentlyContinue

& $MakeAppx pack /d $StageDir /p $PackagePath /overwrite
if ($LASTEXITCODE -ne 0) {
  throw "MakeAppx failed with exit code $LASTEXITCODE."
}

Write-Host "Unsigned Store MSIX written to $PackagePath"
Write-Host "Use Partner Center's package identity values before uploading a final package."
