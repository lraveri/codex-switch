import { promises as fs } from "node:fs";
import path from "node:path";

import { parseAuthMetadata } from "./auth.ts";
import {
  ensureDir,
  fileExists,
  readJsonFile,
  resolveDefaultCodexHome,
  resolveDefaultStorageDir,
  sha256,
  writeFileAtomic,
  writeJsonAtomic
} from "./fs.ts";
import type {
  CodexSwitchOptions,
  CurrentAuthMetadata,
  CurrentProfileResult,
  LoadProfileResult,
  ProfileRecord,
  SaveProfileResult,
  StateFile
} from "./types.ts";

const STATE_VERSION = 1 as const;

export class CodexSwitch {
  readonly storageDir: string;
  readonly codexHome: string;

  constructor(options: CodexSwitchOptions = {}) {
    this.storageDir = path.resolve(options.storageDir ?? resolveDefaultStorageDir());
    this.codexHome = path.resolve(options.codexHome ?? resolveDefaultCodexHome());
  }

  async saveProfile(name: string): Promise<SaveProfileResult> {
    validateProfileName(name);

    const authPath = this.getCodexAuthPath();
    const authContent = await this.readCurrentAuthBytes();
    const metadata = this.buildProfileRecord(name, authContent, "save");
    const state = await this.readState();

    await writeFileAtomic(metadata.authFilePath, authContent);
    state.profiles[name] = metadata;
    state.activeProfile = name;
    await this.writeState(state);

    return { profile: metadata, authFilePath: authPath };
  }

  async loadProfile(name: string): Promise<LoadProfileResult> {
    validateProfileName(name);

    const state = await this.readState();
    const targetPath = this.getProfileAuthPath(name);

    if (!(await fileExists(targetPath))) {
      throw new Error(`Profile "${name}" does not exist`);
    }

    const targetContent = await fs.readFile(targetPath);
    let syncedProfile: ProfileRecord | null = null;

    const currentProfileName = await this.resolveCurrentProfileName(state, name);

    if (currentProfileName && currentProfileName !== name) {
      const currentAuthPath = this.getCodexAuthPath();
      if (await fileExists(currentAuthPath)) {
        const currentContent = await fs.readFile(currentAuthPath);
        syncedProfile = this.buildProfileRecord(currentProfileName, currentContent, "sync");
        await writeFileAtomic(syncedProfile.authFilePath, currentContent);
        state.profiles[currentProfileName] = syncedProfile;
      }
    }

    await ensureDir(this.codexHome);
    await writeFileAtomic(this.getCodexAuthPath(), targetContent);

    const targetProfile =
      state.profiles[name] ?? this.buildProfileRecord(name, targetContent, "save");
    state.profiles[name] = targetProfile;
    state.activeProfile = name;
    await this.writeState(state);

    return {
      profile: targetProfile,
      authFilePath: this.getCodexAuthPath(),
      syncedProfile
    };
  }

  async listProfiles(): Promise<ProfileRecord[]> {
    const state = await this.readState();

    return Object.values(state.profiles).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }

  async getCurrentProfile(): Promise<CurrentProfileResult> {
    const state = await this.readState();
    const currentAuthPath = this.getCodexAuthPath();
    const currentAuth = await this.readCurrentAuthMetadata();
    const profile = state.activeProfile ? state.profiles[state.activeProfile] ?? null : null;

    return {
      activeProfile: state.activeProfile,
      profile,
      currentAuthPath,
      currentAuth
    };
  }

  async removeProfile(name: string): Promise<void> {
    validateProfileName(name);

    const state = await this.readState();
    const profile = state.profiles[name];

    if (!profile) {
      throw new Error(`Profile "${name}" does not exist`);
    }

    await fs.rm(path.dirname(profile.authFilePath), { recursive: true, force: true });
    delete state.profiles[name];

    if (state.activeProfile === name) {
      state.activeProfile = null;
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

    if (state.profiles[toName] || (await fileExists(this.getProfileAuthPath(toName)))) {
      throw new Error(`Profile "${toName}" already exists`);
    }

    const sourceDir = path.dirname(source.authFilePath);
    const targetDir = path.join(this.getProfilesDir(), toName);
    await ensureDir(this.getProfilesDir());
    await fs.rename(sourceDir, targetDir);

    const renamed: ProfileRecord = {
      ...source,
      name: toName,
      authFilePath: path.join(targetDir, "auth.json")
    };

    delete state.profiles[fromName];
    state.profiles[toName] = renamed;

    if (state.activeProfile === fromName) {
      state.activeProfile = toName;
    }

    await this.writeState(state);
    return renamed;
  }

  private async readCurrentAuthBytes(): Promise<Buffer> {
    const authPath = this.getCodexAuthPath();

    if (!(await fileExists(authPath))) {
      throw new Error(`Current Codex auth file not found at ${authPath}`);
    }

    return fs.readFile(authPath);
  }

  private async readCurrentAuthMetadata(): Promise<CurrentAuthMetadata | null> {
    try {
      const content = await this.readCurrentAuthBytes();
      return parseAuthMetadata(content.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in current Codex auth file at ${this.getCodexAuthPath()}`);
      }

      if (error instanceof Error && error.message.startsWith("Current Codex auth file not found")) {
        return null;
      }

      throw error;
    }
  }

  private async readState(): Promise<StateFile> {
    const statePath = this.getStatePath();

    if (!(await fileExists(statePath))) {
      return {
        version: STATE_VERSION,
        activeProfile: null,
        profiles: {}
      };
    }

    const state = await readJsonFile<StateFile>(statePath);

    return {
      version: STATE_VERSION,
      activeProfile: state.activeProfile ?? null,
      profiles: state.profiles ?? {}
    };
  }

  private async writeState(state: StateFile): Promise<void> {
    await writeJsonAtomic(this.getStatePath(), state);
  }

  private buildProfileRecord(
    name: string,
    authContent: Buffer,
    source: "save" | "sync"
  ): ProfileRecord {
    const metadata = parseAuthMetadata(authContent.toString("utf8"));

    return {
      name,
      authMode: metadata.authMode,
      email: metadata.email,
      accountId: metadata.accountId,
      lastSavedAt: new Date().toISOString(),
      source,
      authFilePath: this.getProfileAuthPath(name)
    };
  }

  getCodexAuthPath(): string {
    return path.join(this.codexHome, "auth.json");
  }

  getProfilesDir(): string {
    return path.join(this.storageDir, "profiles");
  }

  getProfileAuthPath(name: string): string {
    return path.join(this.getProfilesDir(), name, "auth.json");
  }

  getStatePath(): string {
    return path.join(this.storageDir, "state.json");
  }

  async isActiveProfileInSync(): Promise<boolean | null> {
    const state = await this.readState();

    if (!state.activeProfile) {
      return null;
    }

    const profile = state.profiles[state.activeProfile];
    if (!profile) {
      return false;
    }

    const currentAuthPath = this.getCodexAuthPath();
    if (!(await fileExists(currentAuthPath)) || !(await fileExists(profile.authFilePath))) {
      return false;
    }

    const [currentContent, savedContent] = await Promise.all([
      fs.readFile(currentAuthPath),
      fs.readFile(profile.authFilePath)
    ]);

    return sha256(currentContent) === sha256(savedContent);
  }

  private async resolveCurrentProfileName(
    state: StateFile,
    targetProfileName: string
  ): Promise<string | null> {
    const currentAuthPath = this.getCodexAuthPath();
    if (!(await fileExists(currentAuthPath))) {
      return state.activeProfile;
    }

    const currentContent = await fs.readFile(currentAuthPath);
    const currentHash = sha256(currentContent);

    for (const profile of Object.values(state.profiles)) {
      if (profile.name === targetProfileName) {
        continue;
      }

      if (!(await fileExists(profile.authFilePath))) {
        continue;
      }

      const savedContent = await fs.readFile(profile.authFilePath);
      if (sha256(savedContent) === currentHash) {
        return profile.name;
      }
    }

    const currentMetadata = parseAuthMetadata(currentContent.toString("utf8"));

    if (currentMetadata.accountId) {
      const matchingByAccountId = Object.values(state.profiles).find(
        (profile) =>
          profile.name !== targetProfileName && profile.accountId === currentMetadata.accountId
      );
      if (matchingByAccountId) {
        return matchingByAccountId.name;
      }
    }

    if (currentMetadata.email) {
      const matchingByEmail = Object.values(state.profiles).find(
        (profile) => profile.name !== targetProfileName && profile.email === currentMetadata.email
      );
      if (matchingByEmail) {
        return matchingByEmail.name;
      }
    }

    return state.activeProfile;
  }
}

function validateProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      'Invalid profile name. Use only letters, numbers, ".", "_" and "-" and start with an alphanumeric character'
    );
  }
}
