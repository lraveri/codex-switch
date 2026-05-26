import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectDir = process.cwd();

interface IdTokenPayload {
  email: string;
  "https://api.openai.com/auth": {
    chatgpt_account_id: string;
  };
}

function createIdToken(payload: IdTokenPayload): string {
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

test("CLI save, list and current work with custom directories", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  await mkdir(codexHome, { recursive: true });

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

  await runCli(["--storage-dir", storageDir, "--codex-home", codexHome, "save", "luca"]);

  const list = await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--json",
    "list"
  ]);
  const current = await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "--json",
    "current"
  ]);

  const profiles = JSON.parse(list.stdout) as Array<{ name: string }>;
  const currentPayload = JSON.parse(current.stdout) as {
    activeProfile: string;
    currentAuth: {
      email: string;
    };
  };

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, "luca");
  assert.equal(currentPayload.activeProfile, "luca");
  assert.equal(currentPayload.currentAuth.email, "luca@example.com");
});

test("CLI load syncs the previously active profile", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-switch-cli-"));
  const storageDir = path.join(rootDir, "storage");
  const codexHome = path.join(rootDir, "codex");
  await mkdir(codexHome, { recursive: true });

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
  await runCli(["--storage-dir", storageDir, "--codex-home", codexHome, "save", "luca"]);

  await writeFile(path.join(codexHome, "auth.json"), workAuth, "utf8");
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "save",
    "luca-talentware"
  ]);

  await writeFile(path.join(codexHome, "auth.json"), personalRefreshedAuth, "utf8");
  await runCli([
    "--storage-dir",
    storageDir,
    "--codex-home",
    codexHome,
    "load",
    "luca-talentware"
  ]);

  const syncedPersonal = await readFile(
    path.join(storageDir, "profiles", "luca", "auth.json"),
    "utf8"
  );
  const currentAuth = await readFile(path.join(codexHome, "auth.json"), "utf8");

  assert.equal(syncedPersonal, personalRefreshedAuth);
  assert.equal(currentAuth, workAuth);
});
