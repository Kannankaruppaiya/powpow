import "./paths-Qu8BKDZT.js";
import { B as theme, R as colorize, S as shortenHomePath, z as isRich } from "./utils-C9Yd70Dr.js";
import "./agent-scope-Coqt3COl.js";
import "./subsystem-A8uKC1In.js";
import "./exec-7lv95ExR.js";
import "./model-selection-DAT49TVG.js";
import "./github-copilot-token-oFsuQdhS.js";
import { t as formatCliCommand } from "./command-format-DpXmP5EG.js";
import "./boolean-CE7i9tBR.js";
import "./env-BF71IqS7.js";
import "./host-env-security-IP2UsfGZ.js";
import "./message-channel-Bc5gLV-e.js";
import { o as readConfigFileSnapshot } from "./config-ClR1jZcN.js";
import "./env-vars-C_dl05a-.js";
import "./manifest-registry-jY2uQzFh.js";
import "./dock-Dwi_4IIN.js";
import "./sessions-fBW7dZrm.js";
import "./plugins-rCyIPzMG.js";
import "./accounts-CWi8B8Jm.js";
import "./accounts-BKSPewAC.js";
import "./accounts-DCHDHCEc.js";
import "./bindings-CmitqUAt.js";
import "./logging-xYH6GmRT.js";
import "./paths-Da74Udq3.js";
import "./chat-envelope-Cy_2InG3.js";
import "./exec-approvals-allowlist-wGY6Lw3S.js";
import "./exec-safe-bin-runtime-policy-DmM-sEYp.js";
import "./plugin-auto-enable-DRupPcLz.js";
import "./prompt-style-DP-Eq7qJ.js";
import { c as shouldMigrateStateFromPath } from "./argv-B6HH6_Su.js";
import "./note-xSQjzVWc.js";
import { t as loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow-B0FTeUaY.js";

//#region src/cli/program/config-guard.ts
const ALLOWED_INVALID_COMMANDS = new Set([
	"doctor",
	"logs",
	"health",
	"help",
	"status"
]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
	"status",
	"probe",
	"health",
	"discover",
	"call",
	"install",
	"uninstall",
	"start",
	"stop",
	"restart"
]);
let didRunDoctorConfigFlow = false;
let configSnapshotPromise = null;
function formatConfigIssues(issues) {
	return issues.map((issue) => `- ${issue.path || "<root>"}: ${issue.message}`);
}
async function getConfigSnapshot() {
	if (process.env.VITEST === "true") return readConfigFileSnapshot();
	configSnapshotPromise ??= readConfigFileSnapshot();
	return configSnapshotPromise;
}
async function ensureConfigReady(params) {
	const commandPath = params.commandPath ?? [];
	if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
		didRunDoctorConfigFlow = true;
		await loadAndMaybeMigrateDoctorConfig({
			options: { nonInteractive: true },
			confirm: async () => false
		});
	}
	const snapshot = await getConfigSnapshot();
	const commandName = commandPath[0];
	const subcommandName = commandPath[1];
	const allowInvalid = commandName ? ALLOWED_INVALID_COMMANDS.has(commandName) || commandName === "gateway" && subcommandName && ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName) : false;
	const issues = snapshot.exists && !snapshot.valid ? formatConfigIssues(snapshot.issues) : [];
	const legacyIssues = snapshot.legacyIssues.length > 0 ? snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`) : [];
	if (!(snapshot.exists && !snapshot.valid)) return;
	const rich = isRich();
	const muted = (value) => colorize(rich, theme.muted, value);
	const error = (value) => colorize(rich, theme.error, value);
	const heading = (value) => colorize(rich, theme.heading, value);
	const commandText = (value) => colorize(rich, theme.command, value);
	params.runtime.error(heading("Config invalid"));
	params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
	if (issues.length > 0) {
		params.runtime.error(muted("Problem:"));
		params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
	}
	if (legacyIssues.length > 0) {
		params.runtime.error(muted("Legacy config keys detected:"));
		params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
	}
	params.runtime.error("");
	params.runtime.error(`${muted("Run:")} ${commandText(formatCliCommand("PowPow doctor --fix"))}`);
	if (!allowInvalid) params.runtime.exit(1);
}

//#endregion
export { ensureConfigReady };