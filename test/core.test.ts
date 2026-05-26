import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CodexSwitch } = await import(
  pathToFileURL(path.join(process.cwd(), "src", "index.ts")).href
);

interface IdTokenPayload {
  email: string;
  "https://api.openai.com/auth": {
    chatgpt_account_id: string;
  };
}

async function setupManager(): Promise<{
  rootDir: string;
  storageDir: string;
  codexHome: string;
  manager: InstanceType<typeof CodexSwitch>;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-test-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  await mkdir(codexHome, { recursive: true });

  return {
    rootDir,
    storageDir,
    codexHome,
    manager: new CodexSwitch({ storageDir, codexHome })
  };
}

function createIdToken(payload: IdTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("saveProfile stores the raw auth.json and marks the profile active", async () => {
  const { manager, codexHome, storageDir } = await setupManager();
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

  const result = await manager.saveProfile("luca");
  const savedContent = await readFile(result.profile.authFilePath, "utf8");
  const state = JSON.parse(await readFile(path.join(storageDir, "state.json"), "utf8")) as {
    activeProfile: string;
    profiles: Record<string, { name: string }>;
  };

  assert.equal(savedContent, authContent);
  assert.equal(result.profile.email, "luca@example.com");
  assert.equal(result.profile.accountId, "acc_personal");
  assert.equal(state.activeProfile, "luca");
  assert.ok(state.profiles.luca);
  assert.equal(state.profiles.luca.name, "luca");
});

test("loadProfile syncs the previously active profile before switching", async () => {
  const { manager, codexHome } = await setupManager();
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
  await manager.saveProfile("luca");

  await writeFile(path.join(codexHome, "auth.json"), workAuth, "utf8");
  await manager.saveProfile("luca-talentware");

  await writeFile(path.join(codexHome, "auth.json"), personalRefreshedAuth, "utf8");
  await manager.loadProfile("luca-talentware");

  const currentAuth = await readFile(path.join(codexHome, "auth.json"), "utf8");
  const syncedPersonal = await readFile(manager.getProfileAuthPath("luca"), "utf8");

  assert.equal(currentAuth, workAuth);
  assert.equal(syncedPersonal, personalRefreshedAuth);
});

test("renameProfile and removeProfile update the registry consistently", async () => {
  const { manager, codexHome } = await setupManager();
  const authContent = `${JSON.stringify(
    {
      auth_mode: "api_key",
      OPENAI_API_KEY: "sk-test"
    },
    null,
    2
  )}\n`;

  await writeFile(path.join(codexHome, "auth.json"), authContent, "utf8");
  await manager.saveProfile("luca");
  const renamed = await manager.renameProfile("luca", "luca-personal");

  assert.equal(renamed.name, "luca-personal");
  assert.equal((await manager.getCurrentProfile()).activeProfile, "luca-personal");

  await manager.removeProfile("luca-personal");
  const current = await manager.getCurrentProfile();
  const profiles = await manager.listProfiles();

  assert.equal(current.activeProfile, null);
  assert.deepEqual(profiles, []);
});
