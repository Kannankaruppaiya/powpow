import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PowPowConfig } from "../config/config.js";
import { resolveStorePath, resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import { note } from "../terminal/note.js";
import { noteStateIntegrity } from "./doctor-state-integrity.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

type EnvSnapshot = {
  HOME?: string;
  POWPOW_HOME?: string;
  POWPOW_STATE_DIR?: string;
  POWPOW_OAUTH_DIR?: string;
};

function captureEnv(): EnvSnapshot {
  return {
    HOME: process.env.HOME,
    POWPOW_HOME: process.env.POWPOW_HOME,
    POWPOW_STATE_DIR: process.env.POWPOW_STATE_DIR,
    POWPOW_OAUTH_DIR: process.env.POWPOW_OAUTH_DIR,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const key of Object.keys(snapshot) as Array<keyof EnvSnapshot>) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setupSessionState(cfg: PowPowConfig, env: NodeJS.ProcessEnv, homeDir: string) {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, () => homeDir);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
}

function stateIntegrityText(): string {
  return vi
    .mocked(note)
    .mock.calls.filter((call) => call[1] === "State integrity")
    .map((call) => String(call[0]))
    .join("\n");
}

const OAUTH_PROMPT_MATCHER = expect.objectContaining({
  message: expect.stringContaining("Create OAuth dir at"),
});

async function runStateIntegrity(cfg: PowPowConfig) {
  setupSessionState(cfg, process.env, process.env.HOME ?? "");
  const confirmSkipInNonInteractive = vi.fn(async () => false);
  await noteStateIntegrity(cfg, { confirmSkipInNonInteractive });
  return confirmSkipInNonInteractive;
}

describe("doctor state integrity oauth dir checks", () => {
  let envSnapshot: EnvSnapshot;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "powpow-doctor-state-integrity-"));
    process.env.HOME = tempHome;
    process.env.POWPOW_HOME = tempHome;
    process.env.POWPOW_STATE_DIR = path.join(tempHome, ".PowPow");
    delete process.env.POWPOW_OAUTH_DIR;
    fs.mkdirSync(process.env.POWPOW_STATE_DIR, { recursive: true, mode: 0o700 });
    vi.mocked(note).mockClear();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("does not prompt for oauth dir when no whatsapp/pairing config is active", async () => {
    const cfg: PowPowConfig = {};
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).not.toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
    const text = stateIntegrityText();
    expect(text).toContain("OAuth dir not present");
    expect(text).not.toContain("CRITICAL: OAuth dir missing");
  });

  it("prompts for oauth dir when whatsapp is configured", async () => {
    const cfg: PowPowConfig = {
      channels: {
        whatsapp: {},
      },
    };
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
    expect(stateIntegrityText()).toContain("CRITICAL: OAuth dir missing");
  });

  it("prompts for oauth dir when a channel dmPolicy is pairing", async () => {
    const cfg: PowPowConfig = {
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    };
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
  });

  it("prompts for oauth dir when POWPOW_OAUTH_DIR is explicitly configured", async () => {
    process.env.POWPOW_OAUTH_DIR = path.join(tempHome, ".oauth");
    const cfg: PowPowConfig = {};
    const confirmSkipInNonInteractive = await runStateIntegrity(cfg);
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(OAUTH_PROMPT_MATCHER);
    expect(stateIntegrityText()).toContain("CRITICAL: OAuth dir missing");
  });

  it("detects orphan transcripts and offers archival remediation", async () => {
    const cfg: PowPowConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    fs.writeFileSync(path.join(sessionsDir, "orphan-session.jsonl"), '{"type":"session"}\n');
    const confirmSkipInNonInteractive = vi.fn(async (params: { message: string }) =>
      params.message.includes("orphan transcript file"),
    );
    await noteStateIntegrity(cfg, { confirmSkipInNonInteractive });
    expect(stateIntegrityText()).toContain("orphan transcript file");
    expect(confirmSkipInNonInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("orphan transcript file"),
      }),
    );
    const files = fs.readdirSync(sessionsDir);
    expect(files.some((name) => name.startsWith("orphan-session.jsonl.deleted."))).toBe(true);
  });

  it("prints powpow-only verification hints when recent sessions are missing transcripts", async () => {
    const cfg: PowPowConfig = {};
    setupSessionState(cfg, process.env, process.env.HOME ?? "");
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "missing-transcript",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
    );

    await noteStateIntegrity(cfg, { confirmSkipInNonInteractive: vi.fn(async () => false) });

    const text = stateIntegrityText();
    expect(text).toContain("recent sessions are missing transcripts");
    expect(text).toMatch(/PowPow sessions --store ".*sessions\.json"/);
    expect(text).toMatch(/PowPow sessions cleanup --store ".*sessions\.json" --dry-run/);
    expect(text).not.toContain("--active");
    expect(text).not.toContain(" ls ");
  });
});
