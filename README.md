# Migel Desktop Connector

Public desktop connector and one-click pairing tools for connecting Migel Android to a local Hermes or OpenClaw desktop agent.

## One-click install and pair

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/gewuart/migel-desktop-connector/main/tools/install-and-pair.sh | bash -s -- https://github.com/gewuart/migel-desktop-connector.git hermes
```

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/gewuart/migel-desktop-connector/main/tools/install-and-pair.ps1 | iex; Install-MigelAndPair https://github.com/gewuart/migel-desktop-connector.git hermes
```

The installer checks Git and Node.js 22+, downloads or updates this repository, installs runtime dependencies, starts the desktop connector, and prints a QR code for Migel Android.

## Security

This repository does not contain relay admin secrets, model API keys, desktop tokens, or Android device tokens. Pairing uses short-lived desktop claims from the Migel account API; long-lived desktop credentials are stored only on the user's computer under `~/.migel/desktop-connector`.
