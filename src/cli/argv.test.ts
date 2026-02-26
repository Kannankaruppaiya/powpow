import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    {
      name: "help flag",
      argv: ["node", "PowPow", "--help"],
      expected: true,
    },
    {
      name: "version flag",
      argv: ["node", "PowPow", "-V"],
      expected: true,
    },
    {
      name: "normal command",
      argv: ["node", "PowPow", "status"],
      expected: false,
    },
    {
      name: "root -v alias",
      argv: ["node", "PowPow", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "PowPow", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with log-level",
      argv: ["node", "PowPow", "--log-level", "debug", "-v"],
      expected: true,
    },
    {
      name: "subcommand -v should not be treated as version",
      argv: ["node", "PowPow", "acp", "-v"],
      expected: false,
    },
    {
      name: "root -v alias with equals profile",
      argv: ["node", "PowPow", "--profile=work", "-v"],
      expected: true,
    },
    {
      name: "subcommand path after global root flags should not be treated as version",
      argv: ["node", "PowPow", "--dev", "skills", "list", "-v"],
      expected: false,
    },
  ])("detects help/version flags: $name", ({ argv, expected }) => {
    expect(hasHelpOrVersion(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "PowPow", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "PowPow", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "PowPow", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPath(argv, 2)).toEqual(expected);
  });

  it.each([
    {
      name: "returns first command token",
      argv: ["node", "PowPow", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "PowPow"],
      expected: null,
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "PowPow", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "PowPow", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "PowPow", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "PowPow", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "PowPow", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "PowPow", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "PowPow", "--", "--timeout=99"],
      expected: undefined,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "PowPow", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "PowPow", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "PowPow", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "PowPow", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "PowPow", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "PowPow", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "PowPow", "status", "--timeout", "nope"],
      expected: undefined,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("builds parse argv from raw args", () => {
    const cases = [
      {
        rawArgs: ["node", "PowPow", "status"],
        expected: ["node", "PowPow", "status"],
      },
      {
        rawArgs: ["node-22", "PowPow", "status"],
        expected: ["node-22", "PowPow", "status"],
      },
      {
        rawArgs: ["node-22.2.0.exe", "PowPow", "status"],
        expected: ["node-22.2.0.exe", "PowPow", "status"],
      },
      {
        rawArgs: ["node-22.2", "PowPow", "status"],
        expected: ["node-22.2", "PowPow", "status"],
      },
      {
        rawArgs: ["node-22.2.exe", "PowPow", "status"],
        expected: ["node-22.2.exe", "PowPow", "status"],
      },
      {
        rawArgs: ["/usr/bin/node-22.2.0", "PowPow", "status"],
        expected: ["/usr/bin/node-22.2.0", "PowPow", "status"],
      },
      {
        rawArgs: ["nodejs", "PowPow", "status"],
        expected: ["nodejs", "PowPow", "status"],
      },
      {
        rawArgs: ["node-dev", "PowPow", "status"],
        expected: ["node", "PowPow", "node-dev", "PowPow", "status"],
      },
      {
        rawArgs: ["PowPow", "status"],
        expected: ["node", "PowPow", "status"],
      },
      {
        rawArgs: ["bun", "src/entry.ts", "status"],
        expected: ["bun", "src/entry.ts", "status"],
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = buildParseArgv({
        programName: "PowPow",
        rawArgs: [...testCase.rawArgs],
      });
      expect(parsed).toEqual([...testCase.expected]);
    }
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "PowPow",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "PowPow", "status"]);
  });

  it("decides when to migrate state", () => {
    const nonMutatingArgv = [
      ["node", "PowPow", "status"],
      ["node", "PowPow", "health"],
      ["node", "PowPow", "sessions"],
      ["node", "PowPow", "config", "get", "update"],
      ["node", "PowPow", "config", "unset", "update"],
      ["node", "PowPow", "models", "list"],
      ["node", "PowPow", "models", "status"],
      ["node", "PowPow", "memory", "status"],
      ["node", "PowPow", "agent", "--message", "hi"],
    ] as const;
    const mutatingArgv = [
      ["node", "PowPow", "agents", "list"],
      ["node", "PowPow", "message", "send"],
    ] as const;

    for (const argv of nonMutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(false);
    }
    for (const argv of mutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(true);
    }
  });

  it.each([
    { path: ["status"], expected: false },
    { path: ["config", "get"], expected: false },
    { path: ["models", "status"], expected: false },
    { path: ["agents", "list"], expected: true },
  ])("reuses command path for migrate state decisions: $path", ({ path, expected }) => {
    expect(shouldMigrateStateFromPath(path)).toBe(expected);
  });
});
