import { Buffer } from "node:buffer";

import type { AuthMode, CurrentAuthMetadata } from "./types.ts";

interface JwtClaims {
  email: string | null;
  accountId: string | null;
}

export function parseAuthMetadata(content: string): CurrentAuthMetadata {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const openAiApiKey = parsed.OPENAI_API_KEY;
  const tokens = parsed.tokens;
  const rawAuthMode = typeof parsed.auth_mode === "string" ? parsed.auth_mode : null;
  const tokenRecord = isRecord(tokens) ? tokens : null;
  const idToken =
    tokenRecord && typeof tokenRecord.id_token === "string" ? tokenRecord.id_token : null;
  const jwtClaims = idToken ? parseJwtClaims(idToken) : { email: null, accountId: null };
  const accountIdFromTokens =
    tokenRecord && typeof tokenRecord.account_id === "string" ? tokenRecord.account_id : null;
  const hasApiKey = typeof openAiApiKey === "string" && openAiApiKey.length > 0;
  const hasTokens = tokenRecord !== null;

  return {
    authMode: detectAuthMode(rawAuthMode, hasApiKey, hasTokens),
    email: jwtClaims.email,
    accountId: jwtClaims.accountId ?? accountIdFromTokens,
    hasApiKey,
    hasTokens,
    rawAuthMode
  };
}

function detectAuthMode(
  rawAuthMode: string | null,
  hasApiKey: boolean,
  hasTokens: boolean
): AuthMode {
  if (rawAuthMode === "chatgpt" || rawAuthMode === "api_key") {
    return rawAuthMode;
  }

  if (hasTokens) {
    return "chatgpt";
  }

  if (hasApiKey) {
    return "api_key";
  }

  return "unknown";
}

function parseJwtClaims(token: string): JwtClaims {
  const parts = token.split(".");
  const payload = parts[1];

  if (!payload) {
    return { email: null, accountId: null };
  }

  try {
    const decoded = Buffer.from(normalizeBase64Url(payload), "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const authClaims = isRecord(parsed["https://api.openai.com/auth"])
      ? parsed["https://api.openai.com/auth"]
      : null;

    return {
      email: typeof parsed.email === "string" ? parsed.email : null,
      accountId:
        authClaims && typeof authClaims.chatgpt_account_id === "string"
          ? authClaims.chatgpt_account_id
          : null
    };
  } catch {
    return { email: null, accountId: null };
  }
}

function normalizeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;

  if (padding === 0) {
    return normalized;
  }

  return normalized.padEnd(normalized.length + (4 - padding), "=");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
