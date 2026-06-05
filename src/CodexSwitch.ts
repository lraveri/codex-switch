import { promises as fs } from "node:fs";
import path from "node:path";

import { parseCodexAuthMetadata } from "./auth.ts";
import {
  ensureDir,
  fileExists,
  readJsonFile,
  resolveDefaultCodexHome,
  resolveDefaultOpenCodeDataDir,
  resolveDefaultStorageDir,
  sha256,
  writeFileAtomic,
  writeJsonAtomic
} from "./fs.ts";
import {
  emptyOpenCodeAccountFile,
  getActiveOpenCodeAccount,
  normalizeOpenCodeAccountFile,
  parseOpenCodeAccountInfoMetadata,
  parseOpenCodeAccountMetadata,
  upsertActiveOpenCodeAccount,
  type OpenCodeAccountFile,
  type OpenCodeAccountInfo
} from "./opencode.ts";
import type {
  AuthTarget,
  CodexSwitchOptions,
  CurrentAuthMetadata,
  CurrentProfileResult,
  LegacyStateFile,
  LoadProfileResult,
  ProfileRecord,
  SaveProfileResult,
  SavedProfileEntry,
  StateFile,
  SwitchProvider
} from "./types.ts";

const STATE_VERSION = 2 as const;

interface LiveSnapshot {
  target: AuthTarget;
  content: Buffer;
  metadata: CurrentAuthMetadata;
}

type SnapshotMap = Partial<Record<AuthTarget, LiveSnapshot>>;

export class CodexSwitch {
  readonly storageDir: string;
  readonly codexHome: string;
  readonly opencodeDataDir: string;

  constructor(options: CodexSwitchOptions = {}) {
    this.storageDir = path.resolve(options.storageDir ?? resolveDefaultStorageDir());
    this.codexHome = path.resolve(options.codexHome ?? resolveDefaultCodexHome());
    this.opencodeDataDir = path.resolve(
      options.opencodeDataDir ?? resolveDefaultOpenCodeDataDir()
    );
  }

  async saveProfile(
    name: string,
    provider: SwitchProvider = "openai"
  ): Promise<SaveProfileResult> {
    validateProfileName(name);

    const snapshots = await this.readCurrentSnapshots(provider);
    this.assertRequiredSnapshots(provider, snapshots, "save");

    const state = await this.readState();
    const profile = this.buildProfileRecord(name, provider, snapshots, "save");

    await this.writeSavedSnapshots(name, provider, snapshots);
    state.profiles[name] = {
      name,
      providers: {
        ...(state.profiles[name]?.providers ?? {}),
        [provider]: profile
      }
    };
    state.activeProfiles[provider] = name;
    await this.writeState(state);

    return {
      provider,
      profile,
      authFilePath: profile.authFilePath,
      authFilePaths: profile.authFilePaths
    };
  }

  async loadProfile(
    name: string,
    provider: SwitchProvider = "openai"
  ): Promise<LoadProfileResult> {
    validateProfileName(name);

    const state = await this.readState();
    const targetProfile = state.profiles[name]?.providers[provider];

    if (!targetProfile) {
      throw new Error(`Profile "${name}" does not exist for provider "${provider}"`);
    }

    await this.assertSavedProfileExists(targetProfile);

    let syncedProfile: ProfileRecord | null = null;
    const currentProfileName = await this.resolveCurrentProfileName(state, provider, name);

    if (currentProfileName && currentProfileName !== name) {
      syncedProfile = await this.syncProfileFromCurrent(state, currentProfileName, provider);
    }

    await this.restoreSavedProfile(targetProfile);
    state.activeProfiles[provider] = name;
    await this.writeState(state);

    return {
      provider,
      profile: targetProfile,
      authFilePath: targetProfile.authFilePath,
      authFilePaths: targetProfile.authFilePaths,
      syncedProfile
    };
  }

  async listProfiles(provider: SwitchProvider = "openai"): Promise<ProfileRecord[]> {
    const state = await this.readState();

    return Object.values(state.profiles)
      .map((profile) => profile.providers[provider] ?? null)
      .filter((profile): profile is ProfileRecord => profile !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getCurrentProfile(provider: SwitchProvider = "openai"): Promise<CurrentProfileResult> {
    const state = await this.readState();
    const currentAuthPaths = this.getCurrentAuthPaths(provider);
    const currentSnapshots = await this.readCurrentSnapshots(provider);
    const primaryTarget = this.selectPrimaryCurrentTarget(provider, currentSnapshots);
    const profileName = state.activeProfiles[provider];
    const profile = profileName ? state.profiles[profileName]?.providers[provider] ?? null : null;

    return {
      provider,
      activeProfile: profileName,
      profile,
      currentAuthPath: primaryTarget
        ? currentAuthPaths[primaryTarget] ?? this.getDefaultCurrentAuthPath(provider)
        : this.getDefaultCurrentAuthPath(provider),
      currentAuth: primaryTarget ? currentSnapshots[primaryTarget]?.metadata ?? null : null,
      currentAuthPaths,
      currentAuths: Object.fromEntries(
        Object.values(currentSnapshots).map((snapshot) => [snapshot.target, snapshot.metadata])
      ) as Partial<Record<AuthTarget, CurrentAuthMetadata>>
    };
  }

  async removeProfile(name: string, provider?: SwitchProvider): Promise<void> {
    validateProfileName(name);

    const state = await this.readState();
    const profile = state.profiles[name];

    if (!profile) {
      throw new Error(`Profile "${name}" does not exist`);
    }

    if (!provider) {
      await fs.rm(path.join(this.getProfilesDir(), name), { recursive: true, force: true });
      delete state.profiles[name];

      for (const key of Object.keys(state.activeProfiles) as SwitchProvider[]) {
        if (state.activeProfiles[key] === name) {
          state.activeProfiles[key] = null;
        }
      }

      await this.writeState(state);
      return;
    }

    if (!profile.providers[provider]) {
      throw new Error(`Profile "${name}" does not exist for provider "${provider}"`);
    }

    await fs.rm(this.getProviderProfileDir(name, provider), { recursive: true, force: true });
    delete profile.providers[provider];

    if (state.activeProfiles[provider] === name) {
      state.activeProfiles[provider] = null;
    }

    if (Object.keys(profile.providers).length === 0) {
      delete state.profiles[name];
      await fs.rm(path.join(this.getProfilesDir(), name), { recursive: true, force: true });
    }

    await this.writeState(state);
  }

  async renameProfile(fromName: string, toName: string): Promise<ProfileRecord> {
    validateProfileName(fromName);
    validateProfileName(toName);

    if (fromName === toName) {
      throw new Error("Source and target profile names must be different");
    }

    const state = await this.readState();
    const source = state.profiles[fromName];

    if (!source) {
      throw new Error(`Profile "${fromName}" does not exist`);
    }

    if (state.profiles[toName] || (await fileExists(path.join(this.getProfilesDir(), toName)))) {
      throw new Error(`Profile "${toName}" already exists`);
    }

    await ensureDir(this.getProfilesDir());
    await fs.rename(path.join(this.getProfilesDir(), fromName), path.join(this.getProfilesDir(), toName));

    const renamed: SavedProfileEntry = {
      name: toName,
      providers: {}
    };

    for (const provider of Object.keys(source.providers) as SwitchProvider[]) {
      const existing = source.providers[provider];

      if (!existing) {
        continue;
      }

      renamed.providers[provider] = {
        ...existing,
        name: toName,
        authFilePath: this.getPrimarySavedAuthPath(toName, provider),
        authFilePaths: this.buildSavedAuthFilePaths(toName, provider, existing.authFilePaths)
      };
    }

    delete state.profiles[fromName];
    state.profiles[toName] = renamed;

    for (const provider of Object.keys(state.activeProfiles) as SwitchProvider[]) {
      if (state.activeProfiles[provider] === fromName) {
        state.activeProfiles[provider] = toName;
      }
    }

    await this.writeState(state);

    return renamed.providers.openai ?? renamed.providers.opencode ?? failMissingRenamedProfile();
  }

  async isActiveProfileInSync(provider: SwitchProvider = "openai"): Promise<boolean | null> {
    const state = await this.readState();
    const profileName = state.activeProfiles[provider];

    if (!profileName) {
      return null;
    }

    const profile = state.profiles[profileName]?.providers[provider];

    if (!profile) {
      return false;
    }

    const currentSnapshots = await this.readCurrentSnapshots(provider);

    for (const target of Object.keys(profile.authFilePaths) as AuthTarget[]) {
      const savedPath = profile.authFilePaths[target];
      const currentSnapshot = currentSnapshots[target];

      if (!savedPath || !currentSnapshot || !(await fileExists(savedPath))) {
        return false;
      }

      const savedContent = await fs.readFile(savedPath);

      if (sha256(savedContent) !== sha256(currentSnapshot.content)) {
        return false;
      }
    }

    return true;
  }

  getCodexAuthPath(): string {
    return path.join(this.codexHome, "auth.json");
  }

  getOpenCodeAccountPath(): string {
    return path.join(this.opencodeDataDir, "account.json");
  }

  getProfilesDir(): string {
    return path.join(this.storageDir, "profiles");
  }

  getStatePath(): string {
    return path.join(this.storageDir, "state.json");
  }

  getProfileAuthPath(name: string, provider: SwitchProvider = "openai"): string {
    return this.getPrimarySavedAuthPath(name, provider);
  }

  private getProviderProfileDir(name: string, provider: SwitchProvider): string {
    return path.join(this.getProfilesDir(), name, provider);
  }

  private getSavedCodexAuthPath(name: string): string {
    return path.join(this.getProviderProfileDir(name, "openai"), "codex-auth.json");
  }

  private getSavedOpenCodeAccountPath(name: string, provider: SwitchProvider): string {
    return path.join(this.getProviderProfileDir(name, provider), "opencode-account.json");
  }

  private getPrimarySavedAuthPath(name: string, provider: SwitchProvider): string {
    return provider === "openai"
      ? this.getSavedCodexAuthPath(name)
      : this.getSavedOpenCodeAccountPath(name, provider);
  }

  private getDefaultCurrentAuthPath(provider: SwitchProvider): string {
    return provider === "openai" ? this.getCodexAuthPath() : this.getOpenCodeAccountPath();
  }

  private getCurrentAuthPaths(provider: SwitchProvider): Partial<Record<AuthTarget, string>> {
    if (provider === "openai") {
      return {
        codex: this.getCodexAuthPath(),
        "opencode-openai": this.getOpenCodeAccountPath()
      };
    }

    return {
      "opencode-opencode": this.getOpenCodeAccountPath()
    };
  }

  private buildSavedAuthFilePaths(
    name: string,
    provider: SwitchProvider,
    authFilePaths: Partial<Record<AuthTarget, string>>
  ): Partial<Record<AuthTarget, string>> {
    const next: Partial<Record<AuthTarget, string>> = {};

    for (const target of Object.keys(authFilePaths) as AuthTarget[]) {
      if (target === "codex") {
        next[target] = this.getSavedCodexAuthPath(name);
        continue;
      }

      next[target] = this.getSavedOpenCodeAccountPath(name, provider);
    }

    return next;
  }

  private async readCurrentSnapshots(provider: SwitchProvider): Promise<SnapshotMap> {
    if (provider === "openai") {
      const [codexSnapshot, openaiSnapshot] = await Promise.all([
        this.tryReadCurrentCodexSnapshot(),
        this.tryReadCurrentOpenCodeSnapshot("openai")
      ]);

      return {
        ...(codexSnapshot ? { codex: codexSnapshot } : {}),
        ...(openaiSnapshot ? { "opencode-openai": openaiSnapshot } : {})
      };
    }

    const opencodeSnapshot = await this.tryReadCurrentOpenCodeSnapshot("opencode");

    return {
      ...(opencodeSnapshot ? { "opencode-opencode": opencodeSnapshot } : {})
    };
  }

  private async tryReadCurrentCodexSnapshot(): Promise<LiveSnapshot | null> {
    const authPath = this.getCodexAuthPath();

    if (!(await fileExists(authPath))) {
      return null;
    }

    const content = await fs.readFile(authPath);

    try {
      return {
        target: "codex",
        content,
        metadata: parseCodexAuthMetadata(content.toString("utf8"))
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in current Codex auth file at ${authPath}`);
      }

      throw error;
    }
  }

  private async tryReadCurrentOpenCodeSnapshot(serviceID: "openai" | "opencode"): Promise<LiveSnapshot | null> {
    const accountFile = await this.readCurrentOpenCodeAccountFile();
    const account = getActiveOpenCodeAccount(accountFile, serviceID);

    if (!account) {
      return null;
    }

    const content = Buffer.from(`${JSON.stringify(account, null, 2)}\n`, "utf8");

    return {
      target: serviceID === "openai" ? "opencode-openai" : "opencode-opencode",
      content,
      metadata: parseOpenCodeAccountInfoMetadata(account)
    };
  }

  private async readCurrentOpenCodeAccountFile(): Promise<OpenCodeAccountFile> {
    const accountPath = this.getOpenCodeAccountPath();

    if (!(await fileExists(accountPath))) {
      return emptyOpenCodeAccountFile();
    }

    try {
      const raw = await readJsonFile<unknown>(accountPath);
      return normalizeOpenCodeAccountFile(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in current OpenCode account file at ${accountPath}`);
      }

      throw error;
    }
  }

  private async writeCurrentOpenCodeAccountFile(accountFile: OpenCodeAccountFile): Promise<void> {
    await writeJsonAtomic(this.getOpenCodeAccountPath(), accountFile);
  }

  private assertRequiredSnapshots(
    provider: SwitchProvider,
    snapshots: SnapshotMap,
    action: "save" | "sync"
  ): void {
    if (provider === "openai" && !snapshots.codex) {
      throw new Error(`Current Codex auth file not found at ${this.getCodexAuthPath()}`);
    }

    if (provider === "opencode" && !snapshots["opencode-opencode"]) {
      const label = action === "save" ? "save" : "sync";
      throw new Error(
        `Current OpenCode account for provider "opencode" not found at ${this.getOpenCodeAccountPath()} during ${label}`
      );
    }
  }

  private buildProfileRecord(
    name: string,
    provider: SwitchProvider,
    snapshots: SnapshotMap,
    source: "save" | "sync"
  ): ProfileRecord {
    const metadata = this.selectProfileMetadata(provider, snapshots);
    const authFilePaths: Partial<Record<AuthTarget, string>> = {};

    for (const target of Object.keys(snapshots) as AuthTarget[]) {
      if (target === "codex") {
        authFilePaths[target] = this.getSavedCodexAuthPath(name);
        continue;
      }

      authFilePaths[target] = this.getSavedOpenCodeAccountPath(name, provider);
    }

    return {
      name,
      provider,
      authMode: metadata.authMode,
      email: metadata.email,
      accountId: metadata.accountId,
      lastSavedAt: new Date().toISOString(),
      source,
      authFilePath: this.selectPrimarySavedPath(name, provider, authFilePaths),
      authFilePaths
    };
  }

  private selectProfileMetadata(provider: SwitchProvider, snapshots: SnapshotMap): CurrentAuthMetadata {
    if (provider === "openai") {
      return (
        snapshots.codex?.metadata ??
        snapshots["opencode-openai"]?.metadata ?? {
          authMode: "unknown",
          email: null,
          accountId: null,
          hasApiKey: false,
          hasTokens: false,
          rawAuthMode: null
        }
      );
    }

    return (
      snapshots["opencode-opencode"]?.metadata ?? {
        authMode: "unknown",
        email: null,
        accountId: null,
        hasApiKey: false,
        hasTokens: false,
        rawAuthMode: null
      }
    );
  }

  private selectPrimarySavedPath(
    name: string,
    provider: SwitchProvider,
    authFilePaths: Partial<Record<AuthTarget, string>>
  ): string {
    if (provider === "openai") {
      return authFilePaths.codex ?? authFilePaths["opencode-openai"] ?? this.getSavedCodexAuthPath(name);
    }

    return authFilePaths["opencode-opencode"] ?? this.getSavedOpenCodeAccountPath(name, "opencode");
  }

  private selectPrimaryCurrentTarget(
    provider: SwitchProvider,
    snapshots: SnapshotMap
  ): AuthTarget | null {
    if (provider === "openai") {
      return snapshots.codex ? "codex" : snapshots["opencode-openai"] ? "opencode-openai" : null;
    }

    return snapshots["opencode-opencode"] ? "opencode-opencode" : null;
  }

  private async writeSavedSnapshots(
    name: string,
    provider: SwitchProvider,
    snapshots: SnapshotMap
  ): Promise<void> {
    if (snapshots.codex) {
      await writeFileAtomic(this.getSavedCodexAuthPath(name), snapshots.codex.content);
    }

    if (provider === "openai" && snapshots["opencode-openai"]) {
      await writeFileAtomic(
        this.getSavedOpenCodeAccountPath(name, provider),
        snapshots["opencode-openai"].content
      );
    }

    if (provider === "opencode" && snapshots["opencode-opencode"]) {
      await writeFileAtomic(
        this.getSavedOpenCodeAccountPath(name, provider),
        snapshots["opencode-opencode"].content
      );
    }
  }

  private async assertSavedProfileExists(profile: ProfileRecord): Promise<void> {
    if (Object.keys(profile.authFilePaths).length === 0) {
      throw new Error(`Profile "${profile.name}" does not have any saved auth snapshots`);
    }

    for (const savedPath of Object.values(profile.authFilePaths)) {
      if (!savedPath || !(await fileExists(savedPath))) {
        throw new Error(`Profile "${profile.name}" is missing saved auth file at ${savedPath}`);
      }
    }
  }

  private async restoreSavedProfile(profile: ProfileRecord): Promise<void> {
    if (profile.authFilePaths.codex) {
      await ensureDir(this.codexHome);
      await writeFileAtomic(this.getCodexAuthPath(), await fs.readFile(profile.authFilePaths.codex));
    }

    if (profile.provider === "openai" && profile.authFilePaths["opencode-openai"]) {
      await this.restoreSavedOpenCodeAccount(profile.authFilePaths["opencode-openai"]);
    }

    if (profile.provider === "opencode" && profile.authFilePaths["opencode-opencode"]) {
      await this.restoreSavedOpenCodeAccount(profile.authFilePaths["opencode-opencode"]);
    }
  }

  private async restoreSavedOpenCodeAccount(savedPath: string): Promise<void> {
    const savedContent = await fs.readFile(savedPath, "utf8");
    const savedMetadata = parseOpenCodeAccountMetadata(savedContent);

    if (!savedMetadata.serviceId) {
      throw new Error(`Saved OpenCode account file at ${savedPath} does not contain a service ID`);
    }

    const savedAccount = normalizeOpenCodeAccountFile({
      version: 2,
      accounts: {
        temp: JSON.parse(savedContent) as unknown
      },
      active: {
        [savedMetadata.serviceId]: "temp"
      }
    });
    const account = getActiveOpenCodeAccount(savedAccount, savedMetadata.serviceId);

    if (!account) {
      throw new Error(`Saved OpenCode account file at ${savedPath} is invalid`);
    }

    const currentAccountFile = await this.readCurrentOpenCodeAccountFile();
    const next = upsertActiveOpenCodeAccount(currentAccountFile, account);
    await this.writeCurrentOpenCodeAccountFile(next);
  }

  private async readState(): Promise<StateFile> {
    const statePath = this.getStatePath();

    if (!(await fileExists(statePath))) {
      return this.createEmptyState();
    }

    const raw = await readJsonFile<unknown>(statePath);
    return this.normalizeState(raw);
  }

  private async writeState(state: StateFile): Promise<void> {
    await writeJsonAtomic(this.getStatePath(), state);
  }

  private createEmptyState(): StateFile {
    return {
      version: STATE_VERSION,
      activeProfiles: {
        openai: null,
        opencode: null
      },
      profiles: {}
    };
  }

  private normalizeState(raw: unknown): StateFile {
    if (isVersion2State(raw)) {
      return {
        version: STATE_VERSION,
        activeProfiles: {
          openai: raw.activeProfiles.openai ?? null,
          opencode: raw.activeProfiles.opencode ?? null
        },
        profiles: Object.fromEntries(
          Object.entries(raw.profiles).map(([name, profile]) => [name, this.normalizeSavedProfileEntry(profile)])
        )
      };
    }

    const legacy = (raw ?? {}) as LegacyStateFile;
    const state = this.createEmptyState();
    state.activeProfiles.openai = legacy.activeProfile ?? null;

    for (const [name, profile] of Object.entries(legacy.profiles ?? {})) {
      state.profiles[name] = {
        name,
        providers: {
          openai: {
            name,
            provider: "openai",
            authMode: profile.authMode,
            email: profile.email,
            accountId: profile.accountId,
            lastSavedAt: profile.lastSavedAt,
            source: profile.source,
            authFilePath: profile.authFilePath,
            authFilePaths: {
              codex: profile.authFilePath
            }
          }
        }
      };
    }

    return state;
  }

  private normalizeSavedProfileEntry(raw: SavedProfileEntry): SavedProfileEntry {
    const name = typeof raw?.name === "string" ? raw.name : "";
    const providers = isRecord(raw?.providers) ? raw.providers : {};
    const next: SavedProfileEntry = {
      name,
      providers: {}
    };

    for (const provider of ["openai", "opencode"] as const) {
      const value = providers[provider];

      if (!isRecord(value)) {
        continue;
      }

      const authFilePaths = isRecord(value.authFilePaths) ? value.authFilePaths : {};
      const normalizedAuthFilePaths: Partial<Record<AuthTarget, string>> = {};

      for (const target of ["codex", "opencode-openai", "opencode-opencode"] as const) {
        const savedPath = authFilePaths[target];
        if (typeof savedPath === "string") {
          normalizedAuthFilePaths[target] = savedPath;
        }
      }

      next.providers[provider] = {
        name: typeof value.name === "string" ? value.name : name,
        provider,
        authMode: typeof value.authMode === "string" ? value.authMode : "unknown",
        email: typeof value.email === "string" ? value.email : null,
        accountId: typeof value.accountId === "string" ? value.accountId : null,
        lastSavedAt:
          typeof value.lastSavedAt === "string" ? value.lastSavedAt : new Date(0).toISOString(),
        source: value.source === "sync" ? "sync" : "save",
        authFilePath:
          typeof value.authFilePath === "string"
            ? value.authFilePath
            : this.getPrimarySavedAuthPath(
                name || (typeof value.name === "string" ? value.name : "unknown"),
                provider,
                normalizedAuthFilePaths
              ),
        authFilePaths: normalizedAuthFilePaths
      };
    }

    return next;
  }

  private async syncProfileFromCurrent(
    state: StateFile,
    name: string,
    provider: SwitchProvider
  ): Promise<ProfileRecord | null> {
    const snapshots = await this.readCurrentSnapshots(provider);

    if (provider === "openai" && !snapshots.codex && !snapshots["opencode-openai"]) {
      return null;
    }

    if (provider === "opencode" && !snapshots["opencode-opencode"]) {
      return null;
    }

    const record = this.buildProfileRecord(name, provider, snapshots, "sync");
    await this.writeSavedSnapshots(name, provider, snapshots);
    state.profiles[name] = {
      name,
      providers: {
        ...(state.profiles[name]?.providers ?? {}),
        [provider]: record
      }
    };
    await this.writeState(state);
    return record;
  }

  private async resolveCurrentProfileName(
    state: StateFile,
    provider: SwitchProvider,
    targetProfileName: string
  ): Promise<string | null> {
    const currentSnapshots = await this.readCurrentSnapshots(provider);
    const otherProfiles = Object.values(state.profiles)
      .map((profile) => profile.providers[provider] ?? null)
      .filter(
        (profile): profile is ProfileRecord =>
          profile !== null && profile.name !== targetProfileName
      );

    for (const target of this.getTargetOrder(provider)) {
      const currentSnapshot = currentSnapshots[target];

      if (!currentSnapshot) {
        continue;
      }

      const currentHash = sha256(currentSnapshot.content);

      for (const profile of otherProfiles) {
        const savedPath = profile.authFilePaths[target];

        if (!savedPath || !(await fileExists(savedPath))) {
          continue;
        }

        const savedContent = await fs.readFile(savedPath);

        if (sha256(savedContent) === currentHash) {
          return profile.name;
        }
      }
    }

    for (const target of this.getTargetOrder(provider)) {
      const metadata = currentSnapshots[target]?.metadata;

      if (!metadata) {
        continue;
      }

      if (metadata.accountId) {
        const match = otherProfiles.find((profile) => profile.accountId === metadata.accountId);
        if (match) {
          return match.name;
        }
      }

      if (metadata.email) {
        const match = otherProfiles.find((profile) => profile.email === metadata.email);
        if (match) {
          return match.name;
        }
      }
    }

    return state.activeProfiles[provider];
  }

  private getTargetOrder(provider: SwitchProvider): AuthTarget[] {
    return provider === "openai"
      ? ["codex", "opencode-openai"]
      : ["opencode-opencode"];
  }
}

function isVersion2State(raw: unknown): raw is StateFile {
  return (
    isRecord(raw) &&
    raw.version === 2 &&
    isRecord(raw.activeProfiles) &&
    isRecord(raw.profiles)
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      'Invalid profile name. Use only letters, numbers, ".", "_" and "-" and start with an alphanumeric character'
    );
  }
}

function failMissingRenamedProfile(): never {
  throw new Error("Renamed profile did not contain any provider data");
}
