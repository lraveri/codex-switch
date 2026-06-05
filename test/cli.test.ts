import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = process.cwd();

interface CodexIdTokenPayload {
  email: string;
  "https://api.openai.com/auth": {
    chatgpt_account_id: string;
  };
}

interface OpenAiAccessTokenPayload {
  "https://api.openai.com/auth": {
    chatgpt_account_id: string;
  };
  "https://api.openai.com/profile": {
    email: string;
  };
}

function createIdToken(payload: CodexIdTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function createAccessToken(payload: OpenAiAccessTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(
    process.execPath,
    [path.join(projectDir, "src", "cli.ts"), ...args],
    { cwd: projectDir, encoding: "utf8" }
  );

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function writeOpenCodeAccountFile(
  opencodeDataDir: string,
  input: {
    openai?: {
      id: string;
      email: string;
      accountId: string;
      refresh: string;
      accessSuffix?: string;
    };
    opencode?: {
      id: string;
      key: string;
    };
  }
): Promise<void> {
  const accounts: Record<string, unknown> = {};
  const active: Record<string, string> = {};

  if (input.openai) {
    accounts[input.openai.id] = {
      id: input.openai.id,
      serviceID: "openai",
      description: "default",
      credential: {
        type: "oauth",
        refresh: input.openai.refresh,
        access: createAccessToken({
          "https://api.openai.com/auth": {
            chatgpt_account_id: input.openai.accountId
          },
          "https://api.openai.com/profile": {
            email: input.openai.email
          }
        }).replace(".signature", `.${input.openai.accessSuffix ?? "signature"}`),
        expires: 1_781_330_365_058
      }
    };
    active.openai = input.openai.id;
  }

  if (input.opencode) {
    accounts[input.opencode.id] = {
      id: input.opencode.id,
      serviceID: "opencode",
      description: "default",
      credential: {
        type: "api",
        key: input.opencode.key
      }
    };
    active.opencode = input.opencode.id;
  }

  await writeFile(
    path.join(opencodeDataDir, "account.json"),
    `${JSON.stringify({ version: 2, accounts, active }, null, 2)}\n`,
    "utf8"
  );
}

test("CLI save, list and current work with OpenCode-aware openai profiles", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  const opencodeDataDir = path.join(rootDir, "opencode");
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeDataDir, { recursive: true });

  const authContent = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "luca@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_personal"
          }
        }),
        access_token: "access",
        refresh_token: "refresh",
        account_id: "acc_personal"
      }
    },
    null,
    2
  )}\n`;
  await writeFile(path.join(codexHome, "auth.json"), authContent, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-personal",
      email: "luca@example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-personal"
    }
  });

  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca"
  ]);

  const list = await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "--json",
    "list"
  ]);
  const current = await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "--json",
    "current"
  ]);

  const profiles = JSON.parse(list.stdout) as Array<{ name: string; provider: string }>;
  const currentPayload = JSON.parse(current.stdout) as {
    provider: string;
    activeProfile: string;
    currentAuths: Record<string, { email: string }>;
  };

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, "luca");
  assert.equal(profiles[0]?.provider, "openai");
  assert.equal(currentPayload.provider, "openai");
  assert.equal(currentPayload.activeProfile, "luca");
  assert.equal(currentPayload.currentAuths.codex.email, "luca@example.com");
  assert.equal(currentPayload.currentAuths["opencode-openai"].email, "luca@example.com");
});

test("CLI load syncs the previously active openai profile for Codex and OpenCode", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  const opencodeDataDir = path.join(rootDir, "opencode");
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeDataDir, { recursive: true });

  const personalAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "luca@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_personal"
          }
        }),
        access_token: "access-personal",
        refresh_token: "refresh-personal",
        account_id: "acc_personal"
      }
    },
    null,
    2
  )}\n`;
  const workAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "luca@talentware.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_work"
          }
        }),
        access_token: "access-work",
        refresh_token: "refresh-work",
        account_id: "acc_work"
      }
    },
    null,
    2
  )}\n`;
  const personalRefreshedAuth = personalAuth.replace("refresh-personal", "refresh-personal-2");

  await writeFile(path.join(codexHome, "auth.json"), personalAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-personal",
      email: "luca@example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-personal"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca"
  ]);

  await writeFile(path.join(codexHome, "auth.json"), workAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-work",
      email: "luca@talentware.com",
      accountId: "acc_work",
      refresh: "openai-refresh-work"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca-talentware"
  ]);

  await writeFile(path.join(codexHome, "auth.json"), personalRefreshedAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-personal",
      email: "luca@example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-personal-2",
      accessSuffix: "personal-2"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "load",
    "luca-talentware"
  ]);

  const syncedPersonal = await readFile(
    path.join(storageDir, "profiles", "luca", "openai", "codex-auth.json"),
    "utf8"
  );
  const syncedOpenCodePersonal = await readFile(
    path.join(storageDir, "profiles", "luca", "openai", "opencode-account.json"),
    "utf8"
  );
  const currentAuth = await readFile(path.join(codexHome, "auth.json"), "utf8");

  assert.equal(syncedPersonal, personalRefreshedAuth);
  assert.match(syncedOpenCodePersonal, /openai-refresh-personal-2/);
  assert.equal(currentAuth, workAuth);
});

test("CLI save and load work for the opencode provider", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  const opencodeDataDir = path.join(rootDir, "opencode");
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeDataDir, { recursive: true });

  await writeOpenCodeAccountFile(opencodeDataDir, {
    opencode: {
      id: "opencode-personal",
      key: "sk-opencode-personal"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "opencode",
    "save",
    "luca"
  ]);

  await writeOpenCodeAccountFile(opencodeDataDir, {
    opencode: {
      id: "opencode-work",
      key: "sk-opencode-work"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "opencode",
    "save",
    "luca-work"
  ]);

  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "opencode",
    "load",
    "luca"
  ]);

  const currentOpenCode = JSON.parse(
    await readFile(path.join(opencodeDataDir, "account.json"), "utf8")
  ) as {
    accounts: Record<string, { credential: { key?: string } }>;
    active: Record<string, string>;
  };

  assert.equal(currentOpenCode.active.opencode, "opencode-personal");
  assert.equal(
    currentOpenCode.accounts[currentOpenCode.active.opencode]?.credential.key,
    "sk-opencode-personal"
  );
});

test("CLI save refuses to overwrite an existing openai profile when the current email differs", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  const opencodeDataDir = path.join(rootDir, "opencode");
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeDataDir, { recursive: true });

  const personalAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "luca@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_personal"
          }
        }),
        access_token: "access-personal",
        refresh_token: "refresh-personal",
        account_id: "acc_personal"
      }
    },
    null,
    2
  )}\n`;
  const workAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "luca@talentware.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_work"
          }
        }),
        access_token: "access-work",
        refresh_token: "refresh-work",
        account_id: "acc_work"
      }
    },
    null,
    2
  )}\n`;

  await writeFile(path.join(codexHome, "auth.json"), personalAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-personal",
      email: "luca@example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-personal"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca"
  ]);

  await writeFile(path.join(codexHome, "auth.json"), workAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-work",
      email: "luca@talentware.com",
      accountId: "acc_work",
      refresh: "openai-refresh-work"
    }
  });

  await assert.rejects(
    () =>
      runCli([
        "--storage-dir",
        storageDir,
        "--codex-home",
        codexHome,
        "--opencode-data-dir",
        opencodeDataDir,
        "--provider",
        "openai",
        "save",
        "luca"
      ]),
    /current auth email "luca@talentware\.com" does not match saved profile email "luca@example\.com"/
  );
});

test("CLI save allows overwriting an existing openai profile when the email differs only by case", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  const opencodeDataDir = path.join(rootDir, "opencode");
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeDataDir, { recursive: true });

  const lowerCaseAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "luca@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_personal"
          }
        }),
        access_token: "access-lower",
        refresh_token: "refresh-lower",
        account_id: "acc_personal"
      }
    },
    null,
    2
  )}\n`;
  const mixedCaseAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "Luca@Example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_personal"
          }
        }),
        access_token: "access-mixed",
        refresh_token: "refresh-mixed",
        account_id: "acc_personal"
      }
    },
    null,
    2
  )}\n`;

  await writeFile(path.join(codexHome, "auth.json"), lowerCaseAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-lower",
      email: "luca@example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-lower"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca"
  ]);

  await writeFile(path.join(codexHome, "auth.json"), mixedCaseAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-mixed",
      email: "Luca@Example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-mixed"
    }
  });

  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca"
  ]);
});

test("CLI save allows overwriting an existing openai profile when the current email is missing", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  const opencodeDataDir = path.join(rootDir, "opencode");
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeDataDir, { recursive: true });

  const oauthAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "luca@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_personal"
          }
        }),
        access_token: "access-oauth",
        refresh_token: "refresh-oauth",
        account_id: "acc_personal"
      }
    },
    null,
    2
  )}\n`;
  const apiKeyAuth = `${JSON.stringify(
    {
      auth_mode: "api_key",
      OPENAI_API_KEY: "sk-test-work"
    },
    null,
    2
  )}\n`;

  await writeFile(path.join(codexHome, "auth.json"), oauthAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-personal",
      email: "luca@example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-personal"
    }
  });
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca"
  ]);

  await writeFile(path.join(codexHome, "auth.json"), apiKeyAuth, "utf8");

  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--opencode-data-dir",
    opencodeDataDir,
    "--provider",
    "openai",
    "save",
    "luca"
  ]);
});
