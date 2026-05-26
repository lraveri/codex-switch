export type AuthMode = "api_key" | "chatgpt" | "unknown";

export interface CodexSwitchOptions {
  storageDir?: string;
  codexHome?: string;
}

export interface ProfileMetadata {
  name: string;
  authMode: AuthMode;
  email: string | null;
  accountId: string | null;
  lastSavedAt: string;
  source: "save" | "sync";
}

export interface ProfileRecord extends ProfileMetadata {
  authFilePath: string;
}

export interface StateFile {
  version: 1;
  activeProfile: string | null;
  profiles: Record<string, ProfileRecord>;
}

export interface SaveProfileResult {
  profile: ProfileRecord;
  authFilePath: string;
}

export interface LoadProfileResult {
  profile: ProfileRecord;
  authFilePath: string;
  syncedProfile: ProfileRecord | null;
}

export interface CurrentProfileResult {
  activeProfile: string | null;
  profile: ProfileRecord | null;
  currentAuthPath: string;
  currentAuth: CurrentAuthMetadata | null;
}

export interface CurrentAuthMetadata {
  authMode: AuthMode;
  email: string | null;
  accountId: string | null;
  hasApiKey: boolean;
  hasTokens: boolean;
  rawAuthMode: string | null;
}
