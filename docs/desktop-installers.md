# Desktop Installer Release Checklist

ScienceSwarm desktop installers are built by the **Desktop Installers** GitHub
Actions workflow. The workflow produces unsigned artifacts for:

- macOS DMG
- Windows NSIS `.exe`
- Linux AppImage

The installers do not bundle local model weights. Setup downloads the selected
Ollama model on first run, defaulting to `gemma4:e4b` with `gemma4:e2b` as the
lower-memory option.

## Build

Run the workflow manually from GitHub Actions, or push a `v*` tag. Each matrix
job runs:

```bash
npm ci
npm run build:standalone
npm run desktop:pack:mac      # macOS runner
npm run desktop:pack:win      # Windows runner
npm run desktop:pack:linux    # Linux runner
npm run desktop:checksums
```

The workflow uploads the platform installer plus `SHA256SUMS.txt`.

## Verify Downloads

After downloading an artifact bundle, verify the checksum manifest before
opening the installer:

```bash
shasum -a 256 -c SHA256SUMS.txt   # macOS
sha256sum -c SHA256SUMS.txt       # Linux
```

On Windows PowerShell, compare the manifest entry with:

```powershell
Get-Item .\ScienceSwarm-*.exe | Get-FileHash -Algorithm SHA256
```

## Release Notes

Before publishing a release, confirm:

- The workflow run used the intended commit or tag.
- All three platform jobs completed successfully.
- `SHA256SUMS.txt` is present in each uploaded artifact bundle.
- The release notes state that installers are unsigned unless signing and
  notarization have been added for that release.
- The release notes state that local model weights are downloaded during setup,
  not shipped inside the installer.
