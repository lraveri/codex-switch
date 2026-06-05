import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CodexSwitch } = await import(
  pathToFileURL(path.join(process.cwd(), "src", "index.ts")).href
);

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

async function setupManager(): Promise<{
  rootDir: string;
  storageDir: string;
  codexHome: string;
  opencodeDataDir: string;
  manager: InstanceType<typeof CodexSwitch>;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-test-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  const opencodeDataDir = path.join(rootDir, "opencode");
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeDataDir, { recursive: true });

  return {
    rootDir,
    storageDir,
    codexHome,
    opencodeDataDir,
    manager: new CodexSwitch({ storageDir, codexHome, opencodeDataDir })
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

async function writeOpenCodeAccountFile(
  opencodeDataDir: string,
  input: {
    openai?: {
      id: string;
      email: string;
      accountId: string;
      accessSuffix?: string;
      refresh: string;
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

test("saveProfile stores Codex and OpenCode openai snapshots and marks the profile active", async () => {
  const { manager, codexHome, opencodeDataDir, storageDir } = await setupManager();
  const idToken = createIdToken({
    email: "luca@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_personal"
    }
  });
  const authContent = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: "access-1",
        refresh_token: "refresh-1",
        account_id: "acc_personal"
      },
      last_refresh: "2026-05-21T10:46:51.448612Z"
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
      refresh: "openai-refresh-1"
    },
    opencode: {
      id: "opencode-personal",
      key: "sk-opencode-personal"
    }
  });

  const result = await manager.saveProfile("luca", "openai");
  const savedCodexContent = await readFile(result.profile.authFilePaths.codex!, "utf8");
  const savedOpenCodeContent = await readFile(
    result.profile.authFilePaths["opencode-openai"]!,
    "utf8"
  );
  const state = JSON.parse(await readFile(path.join(storageDir, "state.json"), "utf8")) as {
    activeProfiles: Record<string, string>;
    profiles: Record<string, { providers: Record<string, { name: string }> }>;
  };

  assert.equal(savedCodexContent, authContent);
  assert.match(savedOpenCodeContent, /"serviceID": "openai"/);
  assert.equal(result.profile.email, "luca@example.com");
  assert.equal(result.profile.accountId, "acc_personal");
  assert.equal(state.activeProfiles.openai, "luca");
  assert.equal(state.profiles.luca.providers.openai.name, "luca");
});

test("loadProfile syncs the previously active openai profile before switching Codex and OpenCode", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
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
  await manager.saveProfile("luca", "openai");

  await writeFile(path.join(codexHome, "auth.json"), workAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-work",
      email: "luca@talentware.com",
      accountId: "acc_work",
      refresh: "openai-refresh-work"
    }
  });
  await manager.saveProfile("luca-talentware", "openai");

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
  await manager.loadProfile("luca-talentware", "openai");

  const currentAuth = await readFile(path.join(codexHome, "auth.json"), "utf8");
  const syncedPersonal = await readFile(manager.getProfileAuthPath("luca"), "utf8");
  const syncedOpenCodePersonal = await readFile(
    path.join(manager.getProfilesDir(), "luca", "openai", "opencode-account.json"),
    "utf8"
  );
  const currentOpenCode = JSON.parse(
    await readFile(path.join(opencodeDataDir, "account.json"), "utf8")
  ) as {
    accounts: Record<string, { serviceID: string; credential: { refresh?: string } }>;
    active: Record<string, string>;
  };

  assert.equal(currentAuth, workAuth);
  assert.equal(syncedPersonal, personalRefreshedAuth);
  assert.match(syncedOpenCodePersonal, /openai-refresh-personal-2/);
  assert.equal(currentOpenCode.active.openai, "openai-work");
  assert.equal(currentOpenCode.accounts["openai-work"]?.credential.refresh, "openai-refresh-work");
});

test("saveProfile and loadProfile support the opencode provider", async () => {
  const { manager, opencodeDataDir } = await setupManager();

  await writeOpenCodeAccountFile(opencodeDataDir, {
    opencode: {
      id: "opencode-personal",
      key: "sk-opencode-personal"
    }
  });
  await manager.saveProfile("luca", "opencode");

  await writeOpenCodeAccountFile(opencodeDataDir, {
    opencode: {
      id: "opencode-work",
      key: "sk-opencode-work"
    }
  });
  await manager.saveProfile("luca-work", "opencode");

  await manager.loadProfile("luca", "opencode");

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

test("saveProfile refuses to overwrite an existing openai profile when the current email differs", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
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
  await manager.saveProfile("luca", "openai");

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
    () => manager.saveProfile("luca", "openai"),
    /current auth email "luca@talentware\.com" does not match saved profile email "luca@example\.com"/
  );
});

test("loadProfile refuses to sync the active openai profile when the current email differs", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
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
  const secondAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "second@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_second"
          }
        }),
        access_token: "access-second",
        refresh_token: "refresh-second",
        account_id: "acc_second"
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
  await manager.saveProfile("luca", "openai");

  await writeFile(path.join(codexHome, "auth.json"), secondAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-second",
      email: "second@example.com",
      accountId: "acc_second",
      refresh: "openai-refresh-second"
    }
  });
  await manager.saveProfile("second", "openai");

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
    () => manager.loadProfile("luca", "openai"),
    /Refusing to sync profile "second": current auth email "luca@talentware\.com" does not match saved profile email "second@example\.com"/
  );
});

test("saveProfile allows overwriting an existing openai profile when the email differs only by case", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
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
  await manager.saveProfile("luca", "openai");

  await writeFile(path.join(codexHome, "auth.json"), mixedCaseAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-mixed",
      email: "Luca@Example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-mixed"
    }
  });

  const result = await manager.saveProfile("luca", "openai");

  assert.equal(result.profile.email, "Luca@Example.com");
});

test("saveProfile allows overwriting an existing openai profile when the saved email is missing", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
  const apiKeyAuth = `${JSON.stringify(
    {
      auth_mode: "api_key",
      OPENAI_API_KEY: "sk-test-personal"
    },
    null,
    2
  )}\n`;
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

  await writeFile(path.join(codexHome, "auth.json"), apiKeyAuth, "utf8");
  await manager.saveProfile("luca", "openai");

  await writeFile(path.join(codexHome, "auth.json"), oauthAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-personal",
      email: "luca@example.com",
      accountId: "acc_personal",
      refresh: "openai-refresh-personal"
    }
  });

  const result = await manager.saveProfile("luca", "openai");

  assert.equal(result.profile.email, "luca@example.com");
});

test("saveProfile allows overwriting an existing openai profile when the current email is missing", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
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
  await manager.saveProfile("luca", "openai");

  await writeFile(path.join(codexHome, "auth.json"), apiKeyAuth, "utf8");

  const result = await manager.saveProfile("luca", "openai");

  assert.equal(result.profile.email, null);
  assert.equal(result.profile.authMode, "api_key");
});

test("loadProfile allows syncing the active openai profile when the email differs only by case", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
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
          email: "work@example.com",
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
  const personalRefreshedAuth = `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: createIdToken({
          email: "LUCA@EXAMPLE.COM",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc_personal"
          }
        }),
        access_token: "access-personal-2",
        refresh_token: "refresh-personal-2",
        account_id: "acc_personal"
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
  await manager.saveProfile("luca", "openai");

  await writeFile(path.join(codexHome, "auth.json"), workAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-work",
      email: "work@example.com",
      accountId: "acc_work",
      refresh: "openai-refresh-work"
    }
  });
  await manager.saveProfile("work", "openai");

  await writeFile(path.join(codexHome, "auth.json"), personalRefreshedAuth, "utf8");
  await writeOpenCodeAccountFile(opencodeDataDir, {
    openai: {
      id: "openai-personal",
      email: "LUCA@EXAMPLE.COM",
      accountId: "acc_personal",
      refresh: "openai-refresh-personal-2"
    }
  });

  const result = await manager.loadProfile("work", "openai");

  assert.equal(result.syncedProfile?.name, "luca");
  assert.equal(result.syncedProfile?.email, "LUCA@EXAMPLE.COM");
});

test("renameProfile and removeProfile update the registry consistently", async () => {
  const { manager, codexHome, opencodeDataDir } = await setupManager();
  const authContent = `${JSON.stringify(
    {
      auth_mode: "api_key",
      OPENAI_API_KEY: "sk-test"
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
    },
    opencode: {
      id: "opencode-personal",
      key: "sk-opencode-personal"
    }
  });
  await manager.saveProfile("luca", "openai");
  await manager.saveProfile("luca", "opencode");

  const renamed = await manager.renameProfile("luca", "luca-personal");

  assert.equal(renamed.name, "luca-personal");
  assert.equal((await manager.getCurrentProfile("openai")).activeProfile, "luca-personal");
  assert.equal((await manager.getCurrentProfile("opencode")).activeProfile, "luca-personal");

  await manager.removeProfile("luca-personal", "openai");
  const afterProviderRemove = await manager.listProfiles("opencode");
  assert.equal(afterProviderRemove.length, 1);
  assert.equal(afterProviderRemove[0]?.name, "luca-personal");

  await manager.removeProfile("luca-personal");
  const current = await manager.getCurrentProfile("opencode");
  const profiles = await manager.listProfiles("opencode");

  assert.equal(current.activeProfile, null);
  assert.deepEqual(profiles, []);
});
