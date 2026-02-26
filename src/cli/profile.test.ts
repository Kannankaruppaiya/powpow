import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "PowPow",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "PowPow", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "PowPow", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "PowPow", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "PowPow", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "PowPow", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "PowPow", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "PowPow", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "PowPow", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".powpow-dev");
    expect(env.POWPOW_PROFILE).toBe("dev");
    expect(env.POWPOW_STATE_DIR).toBe(expectedStateDir);
    expect(env.POWPOW_CONFIG_PATH).toBe(path.join(expectedStateDir, "PowPow.json"));
    expect(env.POWPOW_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      POWPOW_STATE_DIR: "/custom",
      POWPOW_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.POWPOW_STATE_DIR).toBe("/custom");
    expect(env.POWPOW_GATEWAY_PORT).toBe("19099");
    expect(env.POWPOW_CONFIG_PATH).toBe(path.join("/custom", "PowPow.json"));
  });

  it("uses POWPOW_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      POWPOW_HOME: "/srv/powpow-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/powpow-home");
    expect(env.POWPOW_STATE_DIR).toBe(path.join(resolvedHome, ".powpow-work"));
    expect(env.POWPOW_CONFIG_PATH).toBe(
      path.join(resolvedHome, ".powpow-work", "PowPow.json"),
    );
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "PowPow doctor --fix",
      env: {},
      expected: "PowPow doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "PowPow doctor --fix",
      env: { POWPOW_PROFILE: "default" },
      expected: "PowPow doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "PowPow doctor --fix",
      env: { POWPOW_PROFILE: "Default" },
      expected: "PowPow doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "PowPow doctor --fix",
      env: { POWPOW_PROFILE: "bad profile" },
      expected: "PowPow doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "PowPow --profile work doctor --fix",
      env: { POWPOW_PROFILE: "work" },
      expected: "PowPow --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "PowPow --dev doctor",
      env: { POWPOW_PROFILE: "dev" },
      expected: "PowPow --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("PowPow doctor --fix", { POWPOW_PROFILE: "work" })).toBe(
      "PowPow --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("PowPow doctor --fix", { POWPOW_PROFILE: "  jbPowPow  " })).toBe(
      "PowPow --profile jbPowPow doctor --fix",
    );
  });

  it("handles command with no args after PowPow", () => {
    expect(formatCliCommand("PowPow", { POWPOW_PROFILE: "test" })).toBe(
      "PowPow --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm PowPow doctor", { POWPOW_PROFILE: "work" })).toBe(
      "pnpm PowPow --profile work doctor",
    );
  });
});
