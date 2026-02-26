import "./paths-Qu8BKDZT.js";
import { B as theme, R as colorize, z as isRich } from "./utils-C9Yd70Dr.js";
import { i as resolveAgentConfig } from "./agent-scope-Coqt3COl.js";
import { C as normalizeAnyChannelId, f as defaultRuntime } from "./subsystem-A8uKC1In.js";
import { c as normalizeMainKey, l as resolveAgentIdFromSessionKey, r as buildAgentMainSessionKey, s as normalizeAgentId, w as parseAgentSessionKey } from "./session-key-C2FENQ1Z.js";
import "./exec-7lv95ExR.js";
import "./model-selection-DAT49TVG.js";
import "./github-copilot-token-oFsuQdhS.js";
import { t as formatCliCommand } from "./command-format-DpXmP5EG.js";
import "./boolean-CE7i9tBR.js";
import "./env-BF71IqS7.js";
import "./host-env-security-IP2UsfGZ.js";
import { t as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-Bc5gLV-e.js";
import { i as loadConfig } from "./config-ClR1jZcN.js";
import "./env-vars-C_dl05a-.js";
import "./manifest-registry-jY2uQzFh.js";
import "./dock-Dwi_4IIN.js";
import { f as resolveSandboxConfigForAgent, i as removeSandboxContainer, m as resolveSandboxToolPolicyForAgent, n as listSandboxContainers, r as removeSandboxBrowserContainer, t as listSandboxBrowsers } from "./sandbox-5vw3WOI7.js";
import "./tool-catalog-aVpRTkDA.js";
import "./chrome-ZqtxYayN.js";
import "./tailscale-DSZX1Br_.js";
import "./ip-oUNIYnzv.js";
import "./tailnet-BNQgd2Nt.js";
import "./ws-Bp1n_Uxk.js";
import "./auth-C9bP0Q14.js";
import "./server-context-BTpg-KNr.js";
import "./frontmatter-D24yp6Oh.js";
import "./skills-CpGz3h87.js";
import "./redact-DeH01ocq.js";
import "./errors-Adli4uDW.js";
import "./fs-safe-CW6eaDK2.js";
import "./paths-CTiFSpAD.js";
import "./ssrf-BTTK8Df4.js";
import "./image-ops-DDebYeLI.js";
import "./store-CLQaQ0tz.js";
import "./ports-BB-_Dytw.js";
import "./trash-B0HKkPsm.js";
import "./server-middleware-BiteXZ6h.js";
import { Q as resolveMainSessionKey, X as resolveAgentMainSessionKey, c as loadSessionStore } from "./sessions-fBW7dZrm.js";
import "./plugins-rCyIPzMG.js";
import "./accounts-CWi8B8Jm.js";
import "./accounts-BKSPewAC.js";
import "./accounts-DCHDHCEc.js";
import "./bindings-CmitqUAt.js";
import "./logging-xYH6GmRT.js";
import { l as resolveStorePath } from "./paths-Da74Udq3.js";
import "./chat-envelope-Cy_2InG3.js";
import { t as formatDurationCompact } from "./format-duration-XLSvPvzN.js";
import { t as formatDocsLink } from "./links-DloDafB-.js";
import { t as formatHelpExamples } from "./help-format-FvjEYf8n.js";
import { confirm } from "@clack/prompts";

//#region src/commands/sandbox-explain.ts
const SANDBOX_DOCS_URL = "https://docs.PowPow.ai/sandbox";
function normalizeExplainSessionKey(params) {
	const raw = (params.session ?? "").trim();
	if (!raw) return resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (raw.includes(":")) return raw;
	if (raw === "global") return "global";
	return buildAgentMainSessionKey({
		agentId: params.agentId,
		mainKey: normalizeMainKey(raw)
	});
}
function inferProviderFromSessionKey(params) {
	const parsed = parseAgentSessionKey(params.sessionKey);
	if (!parsed) return;
	const rest = parsed.rest.trim();
	if (!rest) return;
	const parts = rest.split(":").filter(Boolean);
	if (parts.length === 0) return;
	const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
	if (parts[0] === configuredMainKey) return;
	const candidate = parts[0]?.trim().toLowerCase();
	if (!candidate) return;
	if (candidate === INTERNAL_MESSAGE_CHANNEL) return INTERNAL_MESSAGE_CHANNEL;
	return normalizeAnyChannelId(candidate) ?? void 0;
}
function resolveActiveChannel(params) {
	const entry = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }))[params.sessionKey];
	const candidate = (entry?.lastChannel ?? entry?.channel ?? entry?.lastProvider ?? entry?.provider ?? "").trim().toLowerCase();
	if (candidate === INTERNAL_MESSAGE_CHANNEL) return INTERNAL_MESSAGE_CHANNEL;
	const normalized = normalizeAnyChannelId(candidate);
	if (normalized) return normalized;
	return inferProviderFromSessionKey({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	});
}
async function sandboxExplainCommand(opts, runtime) {
	const cfg = loadConfig();
	const defaultAgentId = resolveAgentIdFromSessionKey(resolveMainSessionKey(cfg));
	const resolvedAgentId = normalizeAgentId(opts.agent?.trim() ? opts.agent : opts.session?.trim() ? resolveAgentIdFromSessionKey(opts.session) : defaultAgentId);
	const sessionKey = normalizeExplainSessionKey({
		cfg,
		agentId: resolvedAgentId,
		session: opts.session
	});
	const sandboxCfg = resolveSandboxConfigForAgent(cfg, resolvedAgentId);
	const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, resolvedAgentId);
	const mainSessionKey = resolveAgentMainSessionKey({
		cfg,
		agentId: resolvedAgentId
	});
	const sessionIsSandboxed = sandboxCfg.mode === "all" ? true : sandboxCfg.mode === "off" ? false : sessionKey.trim() !== mainSessionKey.trim();
	const channel = resolveActiveChannel({
		cfg,
		agentId: resolvedAgentId,
		sessionKey
	});
	const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
	const elevatedGlobal = cfg.tools?.elevated;
	const elevatedAgent = agentConfig?.tools?.elevated;
	const elevatedGlobalEnabled = elevatedGlobal?.enabled !== false;
	const elevatedAgentEnabled = elevatedAgent?.enabled !== false;
	const elevatedEnabled = elevatedGlobalEnabled && elevatedAgentEnabled;
	const globalAllow = channel ? elevatedGlobal?.allowFrom?.[channel] : void 0;
	const agentAllow = channel ? elevatedAgent?.allowFrom?.[channel] : void 0;
	const allowTokens = (values) => (values ?? []).map((v) => String(v).trim()).filter(Boolean);
	const globalAllowTokens = allowTokens(globalAllow);
	const agentAllowTokens = allowTokens(agentAllow);
	const elevatedAllowedByConfig = elevatedEnabled && Boolean(channel) && globalAllowTokens.length > 0 && (elevatedAgent?.allowFrom ? agentAllowTokens.length > 0 : true);
	const elevatedAlwaysAllowedByConfig = elevatedAllowedByConfig && globalAllowTokens.includes("*") && (elevatedAgent?.allowFrom ? agentAllowTokens.includes("*") : true);
	const elevatedFailures = [];
	if (!elevatedGlobalEnabled) elevatedFailures.push({
		gate: "enabled",
		key: "tools.elevated.enabled"
	});
	if (!elevatedAgentEnabled) elevatedFailures.push({
		gate: "enabled",
		key: "agents.list[].tools.elevated.enabled"
	});
	if (channel && globalAllowTokens.length === 0) elevatedFailures.push({
		gate: "allowFrom",
		key: `tools.elevated.allowFrom.${channel}`
	});
	if (channel && elevatedAgent?.allowFrom && agentAllowTokens.length === 0) elevatedFailures.push({
		gate: "allowFrom",
		key: `agents.list[].tools.elevated.allowFrom.${channel}`
	});
	const fixIt = [];
	if (sandboxCfg.mode !== "off") {
		fixIt.push("agents.defaults.sandbox.mode=off");
		fixIt.push("agents.list[].sandbox.mode=off");
	}
	fixIt.push("tools.sandbox.tools.allow");
	fixIt.push("tools.sandbox.tools.deny");
	fixIt.push("agents.list[].tools.sandbox.tools.allow");
	fixIt.push("agents.list[].tools.sandbox.tools.deny");
	fixIt.push("tools.elevated.enabled");
	if (channel) fixIt.push(`tools.elevated.allowFrom.${channel}`);
	const payload = {
		docsUrl: SANDBOX_DOCS_URL,
		agentId: resolvedAgentId,
		sessionKey,
		mainSessionKey,
		sandbox: {
			mode: sandboxCfg.mode,
			scope: sandboxCfg.scope,
			perSession: sandboxCfg.scope === "session",
			workspaceAccess: sandboxCfg.workspaceAccess,
			workspaceRoot: sandboxCfg.workspaceRoot,
			sessionIsSandboxed,
			tools: {
				allow: toolPolicy.allow,
				deny: toolPolicy.deny,
				sources: toolPolicy.sources
			}
		},
		elevated: {
			enabled: elevatedEnabled,
			channel,
			allowedByConfig: elevatedAllowedByConfig,
			alwaysAllowedByConfig: elevatedAlwaysAllowedByConfig,
			allowFrom: {
				global: channel ? globalAllowTokens : void 0,
				agent: elevatedAgent?.allowFrom && channel ? agentAllowTokens : void 0
			},
			failures: elevatedFailures
		},
		fixIt
	};
	if (opts.json) {
		runtime.log(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}
	const rich = isRich();
	const heading = (value) => colorize(rich, theme.heading, value);
	const key = (value) => colorize(rich, theme.muted, value);
	const value = (val) => colorize(rich, theme.info, val);
	const ok = (val) => colorize(rich, theme.success, val);
	const warn = (val) => colorize(rich, theme.warn, val);
	const err = (val) => colorize(rich, theme.error, val);
	const bool = (flag) => flag ? ok("true") : err("false");
	const lines = [];
	lines.push(heading("Effective sandbox:"));
	lines.push(`  ${key("agentId:")} ${value(payload.agentId)}`);
	lines.push(`  ${key("sessionKey:")} ${value(payload.sessionKey)}`);
	lines.push(`  ${key("mainSessionKey:")} ${value(payload.mainSessionKey)}`);
	lines.push(`  ${key("runtime:")} ${payload.sandbox.sessionIsSandboxed ? warn("sandboxed") : ok("direct")}`);
	lines.push(`  ${key("mode:")} ${value(payload.sandbox.mode)} ${key("scope:")} ${value(payload.sandbox.scope)} ${key("perSession:")} ${bool(payload.sandbox.perSession)}`);
	lines.push(`  ${key("workspaceAccess:")} ${value(payload.sandbox.workspaceAccess)} ${key("workspaceRoot:")} ${value(payload.sandbox.workspaceRoot)}`);
	lines.push("");
	lines.push(heading("Sandbox tool policy:"));
	lines.push(`  ${key(`allow (${payload.sandbox.tools.sources.allow.source}):`)} ${value(payload.sandbox.tools.allow.join(", ") || "(empty)")}`);
	lines.push(`  ${key(`deny  (${payload.sandbox.tools.sources.deny.source}):`)} ${value(payload.sandbox.tools.deny.join(", ") || "(empty)")}`);
	lines.push("");
	lines.push(heading("Elevated:"));
	lines.push(`  ${key("enabled:")} ${bool(payload.elevated.enabled)}`);
	lines.push(`  ${key("channel:")} ${value(payload.elevated.channel ?? "(unknown)")}`);
	lines.push(`  ${key("allowedByConfig:")} ${bool(payload.elevated.allowedByConfig)}`);
	if (payload.elevated.failures.length > 0) lines.push(`  ${key("failing gates:")} ${warn(payload.elevated.failures.map((f) => `${f.gate} (${f.key})`).join(", "))}`);
	if (payload.sandbox.mode === "non-main" && payload.sandbox.sessionIsSandboxed) {
		lines.push("");
		lines.push(`${warn("Hint:")} sandbox mode is non-main; use main session key to run direct: ${value(payload.mainSessionKey)}`);
	}
	lines.push("");
	lines.push(heading("Fix-it:"));
	for (const key of payload.fixIt) lines.push(`  - ${key}`);
	lines.push("");
	lines.push(`${key("Docs:")} ${formatDocsLink("/sandbox", "docs.PowPow.ai/sandbox")}`);
	runtime.log(`${lines.join("\n")}\n`);
}

//#endregion
//#region src/commands/sandbox-formatters.ts
/**
* Formatting utilities for sandbox CLI output
*/
function formatStatus(running) {
	return running ? "🟢 running" : "⚫ stopped";
}
function formatSimpleStatus(running) {
	return running ? "running" : "stopped";
}
function formatImageMatch(matches) {
	return matches ? "✓" : "⚠️  mismatch";
}

//#endregion
//#region src/commands/sandbox-display.ts
function displayItems(items, config, runtime) {
	if (items.length === 0) {
		runtime.log(config.emptyMessage);
		return;
	}
	runtime.log(`\n${config.title}\n`);
	for (const item of items) config.renderItem(item, runtime);
}
function displayContainers(containers, runtime) {
	displayItems(containers, {
		emptyMessage: "No sandbox containers found.",
		title: "📦 Sandbox Containers:",
		renderItem: (container, rt) => {
			rt.log(`  ${container.containerName}`);
			rt.log(`    Status:  ${formatStatus(container.running)}`);
			rt.log(`    Image:   ${container.image} ${formatImageMatch(container.imageMatch)}`);
			rt.log(`    Age:     ${formatDurationCompact(Date.now() - container.createdAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Idle:    ${formatDurationCompact(Date.now() - container.lastUsedAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Session: ${container.sessionKey}`);
			rt.log("");
		}
	}, runtime);
}
function displayBrowsers(browsers, runtime) {
	displayItems(browsers, {
		emptyMessage: "No sandbox browser containers found.",
		title: "🌐 Sandbox Browser Containers:",
		renderItem: (browser, rt) => {
			rt.log(`  ${browser.containerName}`);
			rt.log(`    Status:  ${formatStatus(browser.running)}`);
			rt.log(`    Image:   ${browser.image} ${formatImageMatch(browser.imageMatch)}`);
			rt.log(`    CDP:     ${browser.cdpPort}`);
			if (browser.noVncPort) rt.log(`    noVNC:   ${browser.noVncPort}`);
			rt.log(`    Age:     ${formatDurationCompact(Date.now() - browser.createdAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Idle:    ${formatDurationCompact(Date.now() - browser.lastUsedAtMs, { spaced: true }) ?? "0s"}`);
			rt.log(`    Session: ${browser.sessionKey}`);
			rt.log("");
		}
	}, runtime);
}
function displaySummary(containers, browsers, runtime) {
	const totalCount = containers.length + browsers.length;
	const runningCount = containers.filter((c) => c.running).length + browsers.filter((b) => b.running).length;
	const mismatchCount = containers.filter((c) => !c.imageMatch).length + browsers.filter((b) => !b.imageMatch).length;
	runtime.log(`Total: ${totalCount} (${runningCount} running)`);
	if (mismatchCount > 0) {
		runtime.log(`\n⚠️  ${mismatchCount} container(s) with image mismatch detected.`);
		runtime.log(`   Run '${formatCliCommand("PowPow sandbox recreate --all")}' to update all containers.`);
	}
}
function displayRecreatePreview(containers, browsers, runtime) {
	runtime.log("\nContainers to be recreated:\n");
	if (containers.length > 0) {
		runtime.log("📦 Sandbox Containers:");
		for (const container of containers) runtime.log(`  - ${container.containerName} (${formatSimpleStatus(container.running)})`);
	}
	if (browsers.length > 0) {
		runtime.log("\n🌐 Browser Containers:");
		for (const browser of browsers) runtime.log(`  - ${browser.containerName} (${formatSimpleStatus(browser.running)})`);
	}
	const total = containers.length + browsers.length;
	runtime.log(`\nTotal: ${total} container(s)`);
}
function displayRecreateResult(result, runtime) {
	runtime.log(`\nDone: ${result.successCount} removed, ${result.failCount} failed`);
	if (result.successCount > 0) runtime.log("\nContainers will be automatically recreated when the agent is next used.");
}

//#endregion
//#region src/commands/sandbox.ts
async function sandboxListCommand(opts, runtime) {
	const containers = opts.browser ? [] : await listSandboxContainers().catch(() => []);
	const browsers = opts.browser ? await listSandboxBrowsers().catch(() => []) : [];
	if (opts.json) {
		runtime.log(JSON.stringify({
			containers,
			browsers
		}, null, 2));
		return;
	}
	if (opts.browser) displayBrowsers(browsers, runtime);
	else displayContainers(containers, runtime);
	displaySummary(containers, browsers, runtime);
}
async function sandboxRecreateCommand(opts, runtime) {
	if (!validateRecreateOptions(opts, runtime)) return;
	const filtered = await fetchAndFilterContainers(opts);
	if (filtered.containers.length + filtered.browsers.length === 0) {
		runtime.log("No containers found matching the criteria.");
		return;
	}
	displayRecreatePreview(filtered.containers, filtered.browsers, runtime);
	if (!opts.force && !await confirmRecreate()) {
		runtime.log("Cancelled.");
		return;
	}
	const result = await removeContainers(filtered, runtime);
	displayRecreateResult(result, runtime);
	if (result.failCount > 0) runtime.exit(1);
}
function validateRecreateOptions(opts, runtime) {
	if (!opts.all && !opts.session && !opts.agent) {
		runtime.error("Please specify --all, --session <key>, or --agent <id>");
		runtime.exit(1);
		return false;
	}
	if ([
		opts.all,
		opts.session,
		opts.agent
	].filter(Boolean).length > 1) {
		runtime.error("Please specify only one of: --all, --session, --agent");
		runtime.exit(1);
		return false;
	}
	return true;
}
async function fetchAndFilterContainers(opts) {
	const allContainers = await listSandboxContainers().catch(() => []);
	const allBrowsers = await listSandboxBrowsers().catch(() => []);
	let containers = opts.browser ? [] : allContainers;
	let browsers = opts.browser ? allBrowsers : [];
	if (opts.session) {
		containers = containers.filter((c) => c.sessionKey === opts.session);
		browsers = browsers.filter((b) => b.sessionKey === opts.session);
	} else if (opts.agent) {
		const matchesAgent = createAgentMatcher(opts.agent);
		containers = containers.filter(matchesAgent);
		browsers = browsers.filter(matchesAgent);
	}
	return {
		containers,
		browsers
	};
}
function createAgentMatcher(agentId) {
	const agentPrefix = `agent:${agentId}`;
	return (item) => item.sessionKey === agentPrefix || item.sessionKey.startsWith(`${agentPrefix}:`);
}
async function confirmRecreate() {
	const result = await confirm({
		message: "This will stop and remove these containers. Continue?",
		initialValue: false
	});
	return result !== false && result !== Symbol.for("clack:cancel");
}
async function removeContainers(filtered, runtime) {
	runtime.log("\nRemoving containers...\n");
	let successCount = 0;
	let failCount = 0;
	for (const container of filtered.containers) if ((await removeContainer(container.containerName, removeSandboxContainer, runtime)).success) successCount++;
	else failCount++;
	for (const browser of filtered.browsers) if ((await removeContainer(browser.containerName, removeSandboxBrowserContainer, runtime)).success) successCount++;
	else failCount++;
	return {
		successCount,
		failCount
	};
}
async function removeContainer(containerName, removeFn, runtime) {
	try {
		await removeFn(containerName);
		runtime.log(`✓ Removed ${containerName}`);
		return { success: true };
	} catch (err) {
		runtime.error(`✗ Failed to remove ${containerName}: ${String(err)}`);
		return { success: false };
	}
}

//#endregion
//#region src/cli/sandbox-cli.ts
const SANDBOX_EXAMPLES = {
	main: [
		["PowPow sandbox list", "List all sandbox containers."],
		["PowPow sandbox list --browser", "List only browser containers."],
		["PowPow sandbox recreate --all", "Recreate all containers."],
		["PowPow sandbox recreate --session main", "Recreate a specific session."],
		["PowPow sandbox recreate --agent mybot", "Recreate agent containers."],
		["PowPow sandbox explain", "Explain effective sandbox config."]
	],
	list: [
		["PowPow sandbox list", "List all sandbox containers."],
		["PowPow sandbox list --browser", "List only browser containers."],
		["PowPow sandbox list --json", "JSON output."]
	],
	recreate: [
		["PowPow sandbox recreate --all", "Recreate all containers."],
		["PowPow sandbox recreate --session main", "Recreate a specific session."],
		["PowPow sandbox recreate --agent mybot", "Recreate a specific agent (includes sub-agents)."],
		["PowPow sandbox recreate --browser --all", "Recreate only browser containers."],
		["PowPow sandbox recreate --all --force", "Skip confirmation."]
	],
	explain: [
		["PowPow sandbox explain", "Show effective sandbox config."],
		["PowPow sandbox explain --session agent:main:main", "Explain a specific session."],
		["PowPow sandbox explain --agent work", "Explain an agent sandbox."],
		["PowPow sandbox explain --json", "JSON output."]
	]
};
function createRunner(commandFn) {
	return async (opts) => {
		try {
			await commandFn(opts, defaultRuntime);
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	};
}
function registerSandboxCli(program) {
	const sandbox = program.command("sandbox").description("Manage sandbox containers (Docker-based agent isolation)").addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.main)}\n`).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sandbox", "docs.PowPow.ai/cli/sandbox")}\n`).action(() => {
		sandbox.help({ error: true });
	});
	sandbox.command("list").description("List sandbox containers and their status").option("--json", "Output result as JSON", false).option("--browser", "List browser containers only", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.list)}\n\n${theme.heading("Output includes:")}\n${theme.muted("- Container name and status (running/stopped)")}\n${theme.muted("- Docker image and whether it matches current config")}\n${theme.muted("- Age (time since creation)")}\n${theme.muted("- Idle time (time since last use)")}\n${theme.muted("- Associated session/agent ID")}`).action(createRunner((opts) => sandboxListCommand({
		browser: Boolean(opts.browser),
		json: Boolean(opts.json)
	}, defaultRuntime)));
	sandbox.command("recreate").description("Remove containers to force recreation with updated config").option("--all", "Recreate all sandbox containers", false).option("--session <key>", "Recreate container for specific session").option("--agent <id>", "Recreate containers for specific agent").option("--browser", "Only recreate browser containers", false).option("--force", "Skip confirmation prompt", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.recreate)}\n\n${theme.heading("Why use this?")}\n${theme.muted("After updating Docker images or sandbox configuration, existing containers continue running with old settings.")}\n${theme.muted("This command removes them so they'll be recreated automatically with current config when next needed.")}\n\n${theme.heading("Filter options:")}\n${theme.muted("  --all          Remove all sandbox containers")}\n${theme.muted("  --session      Remove container for specific session key")}\n${theme.muted("  --agent        Remove containers for agent (includes agent:id:* variants)")}\n\n${theme.heading("Modifiers:")}\n${theme.muted("  --browser      Only affect browser containers (not regular sandbox)")}\n${theme.muted("  --force        Skip confirmation prompt")}`).action(createRunner((opts) => sandboxRecreateCommand({
		all: Boolean(opts.all),
		session: opts.session,
		agent: opts.agent,
		browser: Boolean(opts.browser),
		force: Boolean(opts.force)
	}, defaultRuntime)));
	sandbox.command("explain").description("Explain effective sandbox/tool policy for a session/agent").option("--session <key>", "Session key to inspect (defaults to agent main)").option("--agent <id>", "Agent id to inspect (defaults to derived agent)").option("--json", "Output result as JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.explain)}\n`).action(createRunner((opts) => sandboxExplainCommand({
		session: opts.session,
		agent: opts.agent,
		json: Boolean(opts.json)
	}, defaultRuntime)));
}

//#endregion
export { registerSandboxCli };