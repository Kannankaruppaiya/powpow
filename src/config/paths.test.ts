import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";

describe("oauth paths", () => {
  it("prefers POWPOW_OAUTH_DIR over POWPOW_STATE_DIR", () => {
    const env = {
      POWPOW_OAUTH_DIR: "/custom/oauth",
      POWPOW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from POWPOW_STATE_DIR when unset", () => {
    const env = {
      POWPOW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function expectPowPowHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.POWPOW_HOME;
    if (!configuredHome) {
      throw new Error("POWPOW_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".PowPow"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".PowPow", "PowPow.json"));
  }

  it("uses POWPOW_STATE_DIR when set", () => {
    const env = {
      POWPOW_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses POWPOW_HOME for default state/config locations", () => {
    const env = {
      POWPOW_HOME: "/srv/powpow-home",
    } as NodeJS.ProcessEnv;
    expectPowPowHomeDefaults(env);
  });

  it("prefers POWPOW_HOME over HOME for default state/config locations", () => {
    const env = {
      POWPOW_HOME: "/srv/powpow-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectPowPowHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [
      path.join(resolvedHome, ".PowPow", "PowPow.json"),
      path.join(resolvedHome, ".PowPow", "powpow.json"),
      path.join(resolvedHome, ".PowPow", "moldbot.json"),
      path.join(resolvedHome, ".PowPow", "moltbot.json"),
      path.join(resolvedHome, ".powpow", "PowPow.json"),
      path.join(resolvedHome, ".powpow", "powpow.json"),
      path.join(resolvedHome, ".powpow", "moldbot.json"),
      path.join(resolvedHome, ".powpow", "moltbot.json"),
      path.join(resolvedHome, ".moldbot", "PowPow.json"),
      path.join(resolvedHome, ".moldbot", "powpow.json"),
      path.join(resolvedHome, ".moldbot", "moldbot.json"),
      path.join(resolvedHome, ".moldbot", "moltbot.json"),
      path.join(resolvedHome, ".moltbot", "PowPow.json"),
      path.join(resolvedHome, ".moltbot", "powpow.json"),
      path.join(resolvedHome, ".moltbot", "moldbot.json"),
      path.join(resolvedHome, ".moltbot", "moltbot.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.PowPow when it exists and legacy dir is missing", async () => {
    await withTempRoot("powpow-state-", async (root) => {
      const newDir = path.join(root, ".PowPow");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("falls back to existing legacy state dir when ~/.PowPow is missing", async () => {
    await withTempRoot("powpow-state-legacy-", async (root) => {
      const legacyDir = path.join(root, ".powpow");
      await fs.mkdir(legacyDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempRoot("powpow-config-", async (root) => {
      const legacyDir = path.join(root, ".PowPow");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "PowPow.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempRoot("powpow-config-override-", async (root) => {
      const legacyDir = path.join(root, ".PowPow");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "PowPow.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { POWPOW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "PowPow.json"));
    });
  });
});
