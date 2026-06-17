---
name: migel-pairing
description: Use when the user wants to pair Migel Android with this desktop Hermes or OpenClaw agent by letting the desktop Skill request a short-lived cloud pairing credential, start the desktop connector, and show a QR code for phone scanning.
version: 0.1.2
---

# Migel Pairing

Use this skill when the user wants to connect Migel Android to this desktop Hermes
or OpenClaw agent. The desktop Skill should request the short-lived pairing
credential from the Migel cloud API; the user should not need to find or type a
pairing code in Android.

## Safety Contract

- Do not ask the user for relay admin secrets, global gateway tokens, model API
  keys, OSS credentials, host, port, path, or device tokens.
- Do not print desktop tokens, Android device tokens, or raw desktop claims.
- Only run pairing from the Migel project root that contains
  `tools/migel-skill-bootstrap.mjs`.
- Tell the user the flow starts a local desktop connector and shows a QR code
  for the Migel Android App to scan.

## Workflow

1. Ask the user to paste the one-click terminal block from Migel Android into
   the desktop terminal. The terminal block locates the Migel project root
   automatically when possible.
2. Run the pairing bootstrap if you are already operating inside the project
   root. The bootstrap is idempotent: it installs the Skill
   when missing, skips installation when the current version is already present,
   updates old versions, asks `api.gewuyishu.cn` for a short-lived desktop
   pairing credential, then continues pairing.

   ```bash
   rtk node tools/migel-skill-bootstrap.mjs --agent hermes
   ```

   For OpenClaw, use:

   ```bash
   rtk node tools/migel-skill-bootstrap.mjs --agent openclaw
   ```

3. Wait for the command to install or update this skill, start the desktop
   connector, and print/open the QR code.
4. Ask the user to scan the QR code with Migel Android, or enter the printed
   fallback pairing code.

## Compatibility Fallbacks

- If Android/API provides an explicit one-time compatibility code, `--pair-code
  MIGEL-XXXX-XXXX` is still accepted and exchanged through the cloud API.
- If internal beta tooling provides a `migel_dc_...` desktop claim, pass it as
  `--desktop-claim`; do not ask normal users for this.

## If Pairing Fails

- If the API cannot issue the cloud pairing credential, report the API error and
  retry later instead of asking the user for forbidden secrets.
- If the desktop connector starts but the phone says the computer is offline,
  wait a few seconds and scan again.
