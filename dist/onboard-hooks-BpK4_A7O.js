import "./paths-Qu8BKDZT.js";
import "./utils-C9Yd70Dr.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-Coqt3COl.js";
import "./subsystem-A8uKC1In.js";
import "./exec-7lv95ExR.js";
import { t as formatCliCommand } from "./command-format-DpXmP5EG.js";
import "./boolean-CE7i9tBR.js";
import "./frontmatter-D24yp6Oh.js";
import "./workspace-BWGqpaZg.js";
import { t as buildWorkspaceHookStatus } from "./hooks-status-DIjFyqwn.js";

//#region src/commands/onboard-hooks.ts
async function setupInternalHooks(cfg, runtime, prompter) {
	await prompter.note([
		"Hooks let you automate actions when agent commands are issued.",
		"Example: Save session context to memory when you issue /new or /reset.",
		"",
		"Learn more: https://docs.PowPow.ai/automation/hooks"
	].join("\n"), "Hooks");
	const eligibleHooks = buildWorkspaceHookStatus(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)), { config: cfg }).hooks.filter((h) => h.eligible);
	if (eligibleHooks.length === 0) {
		await prompter.note("No eligible hooks found. You can configure hooks later in your config.", "No Hooks Available");
		return cfg;
	}
	const selected = (await prompter.multiselect({
		message: "Enable hooks?",
		options: [{
			value: "__skip__",
			label: "Skip for now"
		}, ...eligibleHooks.map((hook) => ({
			value: hook.name,
			label: `${hook.emoji ?? "🔗"} ${hook.name}`,
			hint: hook.description
		}))]
	})).filter((name) => name !== "__skip__");
	if (selected.length === 0) return cfg;
	const entries = { ...cfg.hooks?.internal?.entries };
	for (const name of selected) entries[name] = { enabled: true };
	const next = {
		...cfg,
		hooks: {
			...cfg.hooks,
			internal: {
				enabled: true,
				entries
			}
		}
	};
	await prompter.note([
		`Enabled ${selected.length} hook${selected.length > 1 ? "s" : ""}: ${selected.join(", ")}`,
		"",
		"You can manage hooks later with:",
		`  ${formatCliCommand("PowPow hooks list")}`,
		`  ${formatCliCommand("PowPow hooks enable <name>")}`,
		`  ${formatCliCommand("PowPow hooks disable <name>")}`
	].join("\n"), "Hooks Configured");
	return next;
}

//#endregion
export { setupInternalHooks };