import type { CurrentAuthMetadata } from "./types.ts";
import {
  createApiKeyMetadata,
  createOauthMetadata,
  parseOpenAiAccessTokenClaims
} from "./auth.ts";

export interface OpenCodeApiCredential {
  type: "api";
  key: string;
  metadata?: Record<string, string>;
}

export interface OpenCodeOauthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

export type OpenCodeCredential = OpenCodeApiCredential | OpenCodeOauthCredential;

export interface OpenCodeAccountInfo {
  id: string;
  serviceID: string;
  description: string;
  credential: OpenCodeCredential;
}

export interface OpenCodeAccountFile {
  version: 2;
  accounts: Record<string, OpenCodeAccountInfo>;
  active: Record<string, string>;
}

export function emptyOpenCodeAccountFile(): OpenCodeAccountFile {
  return {
    version: 2,
    accounts: {},
    active: {}
  };
}

export function normalizeOpenCodeAccountFile(raw: unknown): OpenCodeAccountFile {
  if (!isRecord(raw)) {
    return emptyOpenCodeAccountFile();
  }

  const accounts = isRecord(raw.accounts) ? raw.accounts : {};
  const active = isRecord(raw.active) ? raw.active : {};

  return {
    version: 2,
    accounts: Object.fromEntries(
      Object.entries(accounts)
        .map(([key, value]) => normalizeOpenCodeAccount(value))
        .filter((value): value is OpenCodeAccountInfo => value !== null)
        .map((account) => [account.id, account])
    ),
    active: Object.fromEntries(
      Object.entries(active).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"
      )
    )
  };
}

export function parseOpenCodeAccountMetadata(content: string): CurrentAuthMetadata {
  const parsed = JSON.parse(content) as unknown;
  const account = normalizeOpenCodeAccount(parsed);

  if (!account) {
    return {
      authMode: "unknown",
      email: null,
      accountId: null,
      hasApiKey: false,
      hasTokens: false,
      rawAuthMode: null
    };
  }

  return parseOpenCodeAccountInfoMetadata(account);
}

export function parseOpenCodeAccountInfoMetadata(account: OpenCodeAccountInfo): CurrentAuthMetadata {
  const target = account.serviceID === "openai" ? "opencode-openai" : "opencode-opencode";

  if (account.credential.type === "api") {
    return createApiKeyMetadata(account.credential.type, target, account.serviceID);
  }

  const claims =
    account.serviceID === "openai"
      ? parseOpenAiAccessTokenClaims(account.credential.access)
      : { email: null, accountId: null };

  return createOauthMetadata(account.credential.type, claims, target, account.serviceID);
}

export function getActiveOpenCodeAccount(
  file: OpenCodeAccountFile,
  serviceID: string
): OpenCodeAccountInfo | null {
  const activeId = file.active[serviceID];
  const activeAccount = activeId ? file.accounts[activeId] : undefined;

  if (activeAccount && activeAccount.serviceID === serviceID) {
    return activeAccount;
  }

  for (const account of Object.values(file.accounts)) {
    if (account.serviceID === serviceID) {
      return account;
    }
  }

  return null;
}

export function upsertActiveOpenCodeAccount(
  file: OpenCodeAccountFile,
  account: OpenCodeAccountInfo
): OpenCodeAccountFile {
  return {
    version: 2,
    accounts: {
      ...file.accounts,
      [account.id]: account
    },
    active: {
      ...file.active,
      [account.serviceID]: account.id
    }
  };
}

function normalizeOpenCodeAccount(raw: unknown): OpenCodeAccountInfo | null {
  if (!isRecord(raw)) {
    return null;
  }

  const credential = normalizeOpenCodeCredential(raw.credential);

  if (
    typeof raw.id !== "string" ||
    typeof raw.serviceID !== "string" ||
    typeof raw.description !== "string" ||
    !credential
  ) {
    return null;
  }

  return {
    id: raw.id,
    serviceID: raw.serviceID,
    description: raw.description,
    credential
  };
}

function normalizeOpenCodeCredential(raw: unknown): OpenCodeCredential | null {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return null;
  }

  if (raw.type === "api" && typeof raw.key === "string") {
    return {
      type: "api",
      key: raw.key,
      ...(isRecord(raw.metadata)
        ? {
            metadata: Object.fromEntries(
              Object.entries(raw.metadata).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string"
              )
            )
          }
        : {})
    };
  }

  if (
    raw.type === "oauth" &&
    typeof raw.refresh === "string" &&
    typeof raw.access === "string" &&
    typeof raw.expires === "number"
  ) {
    return {
      type: "oauth",
      refresh: raw.refresh,
      access: raw.access,
      expires: raw.expires
    };
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
