# codex-switch

`codex-switch` is a small CLI and library to switch between multiple Codex and OpenCode accounts without losing refresh tokens.

It saves each account as raw auth snapshots, and restores them when you want to switch back.

## Why it exists

Codex and OpenCode can refresh tokens while an account is active. If you manually copy files around, an older saved file can become stale.

`codex-switch` avoids that problem:

- `save <profile>` stores the current provider auth snapshots as-is
- `load <profile>` restores a saved provider profile
- before loading another profile, it syncs the currently active provider auth back into its saved profile when it can identify the match

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
codex-switch --provider opencode save personal
codex-switch --provider opencode load work
```

Typical workflow:

1. Log into Codex with one account.
2. Run `codex-switch save <profile>`.
3. Log into Codex with another account.
4. Run `codex-switch save <another-profile>`.
5. Switch anytime with `codex-switch load <profile>`.
6. If you also use OpenCode, save or load its `opencode` provider with `--provider opencode`.

## Commands

- `codex-switch save <profile> [--provider openai|opencode]`
  Save the current provider auth under a profile name.
- `codex-switch load <profile> [--provider openai|opencode]`
  Restore a saved profile into the selected provider.
- `codex-switch list [--provider openai|opencode]`
  Show saved profiles for the selected provider.
- `codex-switch current [--provider openai|opencode]`
  Show the currently active saved profile and current auth metadata for the selected provider.
- `codex-switch rename <from> <to>`
  Rename a saved profile.
- `codex-switch remove <profile> [--provider openai|opencode]`
  Delete a saved profile, or only the selected provider snapshot when `--provider` is passed.

Global options:

- `--storage-dir <path>`
- `--codex-home <path>`
- `--opencode-data-dir <path>`
- `--provider <openai|opencode>`
- `--json`

## How it works

- For `openai`, the tool stores the raw Codex `auth.json` and, when available, the active OpenCode `serviceID=openai` account from `account.json`.
- For `opencode`, the tool stores the active OpenCode `serviceID=opencode` account from `account.json`.
- Before switching, the tool tries to detect which saved profile matches the current live auth.
- If it finds a match, it syncs the latest live auth back into that saved profile first.

Matching is based on:

1. exact raw file hash
2. `accountId`
3. `email`
4. fallback to the last active saved profile

This reduces the chance of overwriting newer refreshed tokens with an older saved file.

## Storage

By default:

- active Codex auth file: `~/.codex/auth.json`
- active OpenCode account file: `~/.local/share/opencode/account.json`
- state file: `~/.codex-switch/state.json`
- saved openai Codex snapshot: `~/.codex-switch/profiles/<profile>/openai/codex-auth.json`
- saved openai OpenCode snapshot: `~/.codex-switch/profiles/<profile>/openai/opencode-account.json`
- saved opencode OpenCode snapshot: `~/.codex-switch/profiles/<profile>/opencode/opencode-account.json`

If `CODEX_HOME` is set, `codex-switch` uses that directory instead of `~/.codex`.
If `OPENCODE_DATA_DIR` is set, `codex-switch` uses that directory instead of `~/.local/share/opencode`.

## Library usage

```ts
import { CodexSwitch } from "codex-switch";

const manager = new CodexSwitch();

await manager.saveProfile("luca");
await manager.loadProfile("luca-talentware");
await manager.saveProfile("luca", "opencode");

const profiles = await manager.listProfiles("openai");
console.log(profiles);
```

## Development notes

- Use Node.js `>= 22`
- If needed, run `nvm use 22`
- Useful scripts:
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
