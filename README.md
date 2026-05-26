# codex-switch

`codex-switch` is a small CLI and library to switch between multiple Codex accounts without losing refresh tokens.

It saves each account as the original raw `auth.json`, and restores it when you want to switch back.

## Why it exists

Codex can refresh tokens while an account is active. If you manually copy files around, an older saved file can become stale.

`codex-switch` avoids that problem:

- `save <profile>` stores the current `auth.json` as-is
- `load <profile>` restores a saved profile
- before loading another profile, it syncs the currently active `auth.json` back into its saved profile when it can identify the match

## Installation

```bash
npm install -g codex-switch
```

Or run it without installing globally:

```bash
npx codex-switch list
```

## Quick start

```bash
codex-switch save personal
codex-switch save work
codex-switch load personal
codex-switch list
codex-switch current
```

Typical workflow:

1. Log into Codex with one account.
2. Run `codex-switch save <profile>`.
3. Log into Codex with another account.
4. Run `codex-switch save <another-profile>`.
5. Switch anytime with `codex-switch load <profile>`.

## Commands

- `codex-switch save <profile>`
  Save the current Codex `auth.json` under a profile name.
- `codex-switch load <profile>`
  Restore a saved profile into Codex.
- `codex-switch list`
  Show saved profiles.
- `codex-switch current`
  Show the currently active saved profile and current auth metadata.
- `codex-switch rename <from> <to>`
  Rename a saved profile.
- `codex-switch remove <profile>`
  Delete a saved profile.

Global options:

- `--storage-dir <path>`
- `--codex-home <path>`
- `--json`

## How it works

- Saved profiles are stored as untouched raw `auth.json` files.
- The active Codex auth file is restored directly from the saved file.
- Before switching, the tool tries to detect which saved profile matches the current `auth.json`.
- If it finds a match, it syncs the latest live `auth.json` back into that saved profile first.

Matching is based on:

1. exact raw file hash
2. `accountId`
3. `email`
4. fallback to the last active saved profile

This reduces the chance of overwriting newer refreshed tokens with an older saved file.

## Storage

By default:

- active Codex auth file: `~/.codex/auth.json`
- state file: `~/.codex-switch/state.json`
- saved profiles: `~/.codex-switch/profiles/<profile>/auth.json`

If `CODEX_HOME` is set, `codex-switch` uses that directory instead of `~/.codex`.

## Library usage

```ts
import { CodexSwitch } from "codex-switch";

const manager = new CodexSwitch();

await manager.saveProfile("luca");
await manager.loadProfile("luca-talentware");

const profiles = await manager.listProfiles();
console.log(profiles);
```

## Development notes

- Use Node.js `>= 22`
- If needed, run `nvm use 22`
- Useful scripts:
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
