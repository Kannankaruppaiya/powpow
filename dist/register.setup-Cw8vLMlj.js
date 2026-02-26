import "./paths-BJtes5yu.js";
import { f as defaultRuntime } from "./subsystem-DXlyH4H4.js";
import { x as shortenHomePath, z as theme } from "./utils-BWJH7VRh.js";
import "./boolean-YY6K2DFz.js";
import "./auth-profiles-KPMal-k-.js";
import { E as ensureAgentWorkspace, _ as DEFAULT_AGENT_WORKSPACE_DIR } from "./agent-scope-Ac0Vygcn.js";
import "./exec-Du-v-jcI.js";
import "./github-copilot-token-CgHPGmmS.js";
import "./host-env-security-DkeGvzp3.js";
import "./manifest-registry-C9O9KUb3.js";
import { l as writeConfigFile, r as createConfigIO } from "./config-B91e8u6L.js";
import "./env-vars-D53NnL-N.js";
import "./dock-DaMhmHr_.js";
import "./message-channel-DYK7E7vt.js";
import "./sessions-DGKLiJDU.js";
import "./plugins-CPaMeorQ.js";
import "./accounts-CafntguV.js";
import "./accounts--1-XHGvw.js";
import "./accounts-DUEZIYFu.js";
import "./bindings-B0Nfghiw.js";
import "./logging-D-Jq2wIo.js";
import { s as resolveSessionTranscriptsDir } from "./paths-BB4B9o0x.js";
import "./chat-envelope-9mWFsNOQ.js";
import "./client-FngVpCQH.js";
import "./call-Dy4jPY6_.js";
import "./pairing-token-DdQlEK2o.js";
import "./net-CliLiAjH.js";
import "./ip-cpmUu6M4.js";
import "./tailnet-DVxZdYPM.js";
import "./redact-CAjBvpi8.js";
import "./errors-BpyuHard.js";
import { t as formatDocsLink } from "./links-C00eySj4.js";
import { n as runCommandWithRuntime } from "./cli-utils-DXfA5936.js";
import "./progress-DF7PrFZS.js";
import "./onboard-helpers-BNEaJ_0q.js";
import "./prompt-style-BzZR3NGi.js";
import { t as hasExplicitOptions } from "./command-options-Ck7nsSTb.js";
import "./note-0Tgggy8C.js";
import "./clack-prompter-u4SxqKXZ.js";
import "./runtime-guard-B4q6EKGg.js";
import "./onboarding-BwuOyEgA.js";
import { n as logConfigUpdated, t as formatConfigPath } from "./logging-x1Y0rmXr.js";
import { t as onboardCommand } from "./onboard-RvbYe_99.js";
import JSON5 from "json5";
import fs from "node:fs/promises";

//#region src/commands/setup.ts
async function readConfigFileRaw(configPath) {
	try {
		const raw = await fs.readFile(configPath, "utf-8");
		const parsed = JSON5.parse(raw);
		if (parsed && typeof parsed === "object") return {
			exists: true,
			parsed
		};
		return {
			exists: true,
			parsed: {}
		};
	} catch {
		return {
			exists: false,
			parsed: {}
		};
	}
}
async function setupCommand(opts, runtime = defaultRuntime) {
	const desiredWorkspace = typeof opts?.workspace === "string" && opts.workspace.trim() ? opts.workspace.trim() : void 0;
	const configPath = createConfigIO().configPath;
	const existingRaw = await readConfigFileRaw(configPath);
	const cfg = existingRaw.parsed;
	const defaults = cfg.agents?.defaults ?? {};
	const workspace = desiredWorkspace ?? defaults.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
	const next = {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				workspace
			}
		}
	};
	if (!existingRaw.exists || defaults.workspace !== workspace) {
		await writeConfigFile(next);
		if (!existingRaw.exists) runtime.log(`Wrote ${formatConfigPath(configPath)}`);
		else logConfigUpdated(runtime, {
			path: configPath,
			suffix: "(set agents.defaults.workspace)"
		});
	} else runtime.log(`Config OK: ${formatConfigPath(configPath)}`);
	const ws = await ensureAgentWorkspace({
		dir: workspace,
		ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap
	});
	runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
	const sessionsDir = resolveSessionTranscriptsDir();
	await fs.mkdir(sessionsDir, { recursive: true });
	runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}

//#endregion
//#region src/cli/program/register.setup.ts
function registerSetupCommand(program) {
	program.command("setup").description("Initialize ~/.PowPow/PowPow.json and the agent workspace").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.PowPow.ai/cli/setup")}\n`).option("--workspace <dir>", "Agent workspace directory (default: ~/.PowPow/workspace; stored as agents.defaults.workspace)").option("--wizard", "Run the interactive onboarding wizard", false).option("--non-interactive", "Run the wizard without prompts", false).option("--mode <mode>", "Wizard mode: local|remote").option("--remote-url <url>", "Remote Gateway WebSocket URL").option("--remote-token <token>", "Remote Gateway token (optional)").action(async (opts, command) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			const hasWizardFlags = hasExplicitOptions(command, [
				"wizard",
				"nonInteractive",
				"mode",
				"remoteUrl",
				"remoteToken"
			]);
			if (opts.wizard || hasWizardFlags) {
				await onboardCommand({
					workspace: opts.workspace,
					nonInteractive: Boolean(opts.nonInteractive),
					mode: opts.mode,
					remoteUrl: opts.remoteUrl,
					remoteToken: opts.remoteToken
				}, defaultRuntime);
				return;
			}
			await setupCommand({ workspace: opts.workspace }, defaultRuntime);
		});
	});
}

//#endregion
export { registerSetupCommand };