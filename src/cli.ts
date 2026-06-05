#!/usr/bin/env -S node

import { CodexSwitch } from "./CodexSwitch.ts";
import type { CurrentProfileResult, ProfileRecord, SwitchProvider } from "./types.ts";

interface CliOptions {
  storageDir?: string;
  codexHome?: string;
  opencodeDataDir?: string;
  provider: SwitchProvider;
  providerProvided: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

async function main(): Promise<void> {
  const { options, command, positionals } = parseArgv(process.argv.slice(2));

  if (options.help || !command) {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (options.version) {
    console.log("0.1.0");
    return;
  }

  const managerOptions: {
    storageDir?: string;
    codexHome?: string;
    opencodeDataDir?: string;
  } = {};
  if (options.storageDir) {
    managerOptions.storageDir = options.storageDir;
  }
  if (options.codexHome) {
    managerOptions.codexHome = options.codexHome;
  }
  if (options.opencodeDataDir) {
    managerOptions.opencodeDataDir = options.opencodeDataDir;
  }

  const manager = new CodexSwitch(managerOptions);

  switch (command) {
    case "save": {
      const name = requirePositional(positionals, 0, "profile name");
      const result = await manager.saveProfile(name, options.provider);
      printOutput(
        options.json,
        result,
        `Saved profile "${name}" for provider "${options.provider}"`
      );
      return;
    }

    case "load": {
      const name = requirePositional(positionals, 0, "profile name");
      const result = await manager.loadProfile(name, options.provider);
      printOutput(
        options.json,
        result,
        `Loaded profile "${name}" for provider "${options.provider}"`
      );
      return;
    }

    case "list": {
      const profiles = await manager.listProfiles(options.provider);
      if (options.json) {
        printJson(profiles);
        return;
      }

      if (profiles.length === 0) {
        console.log(`No profiles saved for provider "${options.provider}"`);
        return;
      }

      const current = await manager.getCurrentProfile(options.provider);
      printProfileList(profiles, current.activeProfile);
      return;
    }

    case "current": {
      const current = await manager.getCurrentProfile(options.provider);
      const inSync = await manager.isActiveProfileInSync(options.provider);
      const payload = { ...current, inSync };

      if (options.json) {
        printJson(payload);
        return;
      }

      printCurrent(current, inSync);
      return;
    }

    case "remove": {
      const name = requirePositional(positionals, 0, "profile name");
      await manager.removeProfile(name, options.providerProvided ? options.provider : undefined);
      console.log(
        options.providerProvided
          ? `Removed provider "${options.provider}" from profile "${name}"`
          : `Removed profile "${name}"`
      );
      return;
    }

    case "rename": {
      const fromName = requirePositional(positionals, 0, "source profile name");
      const toName = requirePositional(positionals, 1, "target profile name");
      const result = await manager.renameProfile(fromName, toName);
      printOutput(options.json, result, `Renamed profile "${fromName}" to "${toName}"`);
      return;
    }

    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

function parseArgv(argv: string[]): {
  options: CliOptions;
  command: string | null;
  positionals: string[];
} {
  const options: CliOptions = {
    provider: "openai",
    providerProvided: false,
    json: false,
    help: false,
    version: false
  };
  const positionals: string[] = [];
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (!value) {
      continue;
    }

    if (value === "--json") {
      options.json = true;
      continue;
    }

    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }

    if (value === "--version" || value === "-v") {
      options.version = true;
      continue;
    }

    if (value === "--storage-dir") {
      options.storageDir = requireOptionValue(argv, index, value);
      index += 1;
      continue;
    }

    if (value === "--codex-home") {
      options.codexHome = requireOptionValue(argv, index, value);
      index += 1;
      continue;
    }

    if (value === "--opencode-data-dir") {
      options.opencodeDataDir = requireOptionValue(argv, index, value);
      index += 1;
      continue;
    }

    if (value === "--provider") {
      const provider = requireOptionValue(argv, index, value);

      if (provider !== "openai" && provider !== "opencode") {
        throw new Error(`Unsupported provider "${provider}". Use "openai" or "opencode"`);
      }

      options.provider = provider;
      options.providerProvided = true;
      index += 1;
      continue;
    }

    if (value.startsWith("--")) {
      throw new Error(`Unknown option "${value}"`);
    }

    if (!command) {
      command = value;
      continue;
    }

    positionals.push(value);
  }

  return { options, command, positionals };
}

function requireOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function requirePositional(positionals: string[], index: number, label: string): string {
  const value = positionals[index];

  if (!value) {
    throw new Error(`Missing ${label}`);
  }

  return value;
}

function printOutput(asJson: boolean, value: unknown, message: string): void {
  if (asJson) {
    printJson(value);
    return;
  }

  console.log(message);
}

function printProfileList(profiles: ProfileRecord[], activeProfile: string | null): void {
  for (const profile of profiles) {
    const marker = profile.name === activeProfile ? "*" : " ";
    const email = profile.email ?? "-";
    console.log(
      `${marker} ${profile.name}\t${profile.provider}\t${profile.authMode}\t${email}\t${profile.lastSavedAt}`
    );
  }
}

function printCurrent(current: CurrentProfileResult, inSync: boolean | null): void {
  console.log(`Provider: ${current.provider}`);

  if (!current.activeProfile || !current.profile) {
    console.log("No active saved profile");
  } else {
    console.log(`Active profile: ${current.activeProfile}`);
    console.log(`Auth mode: ${current.profile.authMode}`);
    console.log(`Email: ${current.profile.email ?? "-"}`);
    console.log(`Account ID: ${current.profile.accountId ?? "-"}`);
    console.log(`Saved auth path: ${current.profile.authFilePath}`);
    console.log(`In sync: ${inSync === null ? "-" : inSync ? "yes" : "no"}`);
  }

  console.log(`Current auth path: ${current.currentAuthPath}`);
  if (current.currentAuth) {
    console.log(`Current auth mode: ${current.currentAuth.authMode}`);
    console.log(`Current email: ${current.currentAuth.email ?? "-"}`);
    console.log(`Current account ID: ${current.currentAuth.accountId ?? "-"}`);
  } else {
    console.log("Current auth file: not found");
  }

  for (const [target, metadata] of Object.entries(current.currentAuths)) {
    if (!metadata || target === current.currentAuth?.target) {
      continue;
    }

    console.log(`${target} auth mode: ${metadata.authMode}`);
    console.log(`${target} email: ${metadata.email ?? "-"}`);
    console.log(`${target} account ID: ${metadata.accountId ?? "-"}`);
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`codex-switch

Usage:
  codex-switch save <profile> [--provider openai|opencode]
  codex-switch load <profile> [--provider openai|opencode]
  codex-switch list [--provider openai|opencode]
  codex-switch current [--provider openai|opencode]
  codex-switch rename <from> <to>
  codex-switch remove <profile> [--provider openai|opencode]

Options:
  --storage-dir <path>
  --codex-home <path>
  --opencode-data-dir <path>
  --provider <openai|opencode>
  --json
  --help
  --version`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
