export type AuthMode = "api_key" | "chatgpt" | "oauth" | "unknown";

export type SwitchProvider = "openai" | "opencode";

export type AuthTarget = "codex" | "opencode-openai" | "opencode-opencode";

export interface CodexSwitchOptions {
  storageDir?: string;
  codexHome?: string;
  opencodeDataDir?: string;
}

export interface ProfileMetadata {
  authMode: AuthMode;
  email: string | null;
  accountId: string | null;
  lastSavedAt: string;
  source: "save" | "sync";
}

export interface ProfileRecord extends ProfileMetadata {
  name: string;
  provider: SwitchProvider;
  authFilePath: string;
  authFilePaths: Partial<Record<AuthTarget, string>>;
}

export interface SavedProfileEntry {
  name: string;
  providers: Partial<Record<SwitchProvider, ProfileRecord>>;
}

export interface StateFile {
  version: 2;
  activeProfiles: Record<SwitchProvider, string | null>;
  profiles: Record<string, SavedProfileEntry>;
}

export interface LegacyProfileRecord extends ProfileMetadata {
  name: string;
  authFilePath: string;
}

export interface LegacyStateFile {
  version?: 1;
  activeProfile?: string | null;
  profiles?: Record<string, LegacyProfileRecord>;
}

export interface SaveProfileResult {
  provider: SwitchProvider;
  profile: ProfileRecord;
  authFilePath: string;
  authFilePaths: Partial<Record<AuthTarget, string>>;
}

export interface LoadProfileResult {
  provider: SwitchProvider;
  profile: ProfileRecord;
  authFilePath: string;
  authFilePaths: Partial<Record<AuthTarget, string>>;
  syncedProfile: ProfileRecord | null;
}

export interface CurrentProfileResult {
  provider: SwitchProvider;
  activeProfile: string | null;
  profile: ProfileRecord | null;
  currentAuthPath: string;
  currentAuth: CurrentAuthMetadata | null;
  currentAuthPaths: Partial<Record<AuthTarget, string>>;
  currentAuths: Partial<Record<AuthTarget, CurrentAuthMetadata>>;
}

export interface CurrentAuthMetadata {
  authMode: AuthMode;
  email: string | null;
  accountId: string | null;
  hasApiKey: boolean;
  hasTokens: boolean;
  rawAuthMode: string | null;
  serviceId?: string;
  target?: AuthTarget;
}
