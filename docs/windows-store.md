# Windows Store release

Kuku's normal Windows release builds NSIS and MSI installers. Microsoft Store submission should use a Store MSIX package instead.

## Why MSIX

- Store-distributed MSIX packages are signed by Microsoft during Store ingestion.
- Local installation of an MSIX still needs a trusted signature, but Partner Center upload does not require buying a public code-signing certificate for the final Store-signed package.
- The package identity values must come from Partner Center after reserving the app name.

## Prerequisites

- Windows SDK, including `MakeAppx.exe`
- Existing Windows build prerequisites from `scripts/setup-windows-build-prereqs.ps1`
- Partner Center app identity values:
  - Package identity name
  - Publisher
  - Publisher display name

## Build

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-windows-store-msix.ps1 `
  -PackageIdentityName "YOUR.PARTNER.CENTER.IDENTITY" `
  -Publisher "CN=YOUR-PUBLISHER-ID" `
  -PublisherDisplayName "kuku" `
  -SkipChecks
```

The unsigned MSIX is written to:

```text
release-artifacts\windows\store\<version>\Kuku_<version>_x64_store.msix
```

## Assets

The MSIX tile assets are generated into the temporary package staging directory from the existing Windows icon during the release script. Store screenshots and marketing images are intentionally not tracked here; prepare them separately when creating the Partner Center listing.

## Submission notes

- Use the MSIX package for Microsoft Store submission.
- Use the NSIS `setup.exe` for direct download distribution.
- If distributing outside the Store at scale, sign `setup.exe`, `.msi`, and `kuku-app.exe` with an Authenticode certificate to reduce SmartScreen friction.
