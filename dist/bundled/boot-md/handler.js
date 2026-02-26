import { n as listAgentIds, s as resolveAgentWorkspaceDir } from "../../agent-scope-LV16AGcF.js";
import "../../paths-DGhxxd_R.js";
import { pt as isGatewayStartupEvent, r as defaultRuntime, t as createSubsystemLogger } from "../../subsystem-3xhEFOyH.js";
import { l as resolveAgentIdFromSessionKey } from "../../session-key-YGVrIVO5.js";
import "../../workspace-BbD3Kass.js";
import "../../model-selection-MeurW_4a.js";
import "../../github-copilot-token-BLvi1M0g.js";
import "../../env-dg1Vq6R_.js";
import "../../boolean-M-esQJt6.js";
import { n as SILENT_REPLY_TOKEN } from "../../tokens-CME7a42x.js";
import { a as createDefaultDeps, i as agentCommand } from "../../pi-embedded-Dsj2-Den.js";
import "../../plugins-toi-1uUy.js";
import "../../accounts-B3jyVzHI.js";
import "../../bindings-6AsTw9R5.js";
import "../../send-CIPI7zkP.js";
import "../../send-QVHUX4ZV.js";
import "../../deliver-D5tmcHzs.js";
import "../../diagnostic-C7jULjsI.js";
import "../../diagnostic-session-state-CAjTSaR3.js";
import "../../accounts-CDbVneGZ.js";
import "../../send-CJBL10K3.js";
import "../../image-ops-CIlRVMHI.js";
import "../../pi-model-discovery-DZrt2PIy.js";
import "../../message-channel-D_VJsPCS.js";
import "../../pi-embedded-helpers-BXcYGfm7.js";
import "../../config-BVY11kC2.js";
import "../../manifest-registry-R4d8uSqf.js";
import "../../dock-CU6BAEqI.js";
import "../../chrome-DPYX8bg6.js";
import "../../ssrf-CoiLWsBO.js";
import "../../frontmatter-CM2DP0fv.js";
import "../../skills-DBJQT9jY.js";
import "../../redact-Bu0ABJUw.js";
import "../../errors-WCORuQlU.js";
import "../../fs-safe-DOHEJD7P.js";
import "../../store-CqI0-rwc.js";
import { B as resolveAgentMainSessionKey, H as resolveMainSessionKey, d as updateSessionStore, s as loadSessionStore } from "../../sessions-BYz6utTL.js";
import "../../accounts-B7R1IsiZ.js";
import { l as resolveStorePath } from "../../paths-CqAHUYfl.js";
import "../../tool-images-CMt0Ll63.js";
import "../../thinking-DWQCK16e.js";
import "../../image-BIA1_Uyx.js";
import "../../reply-prefix-BOxoO1Ns.js";
import "../../manager-BW9ulmNk.js";
import "../../gemini-auth-BXgwGHBK.js";
import "../../fetch-guard-ZpIM9DWw.js";
import "../../query-expansion-B7aQNYg9.js";
import "../../retry-B6tUuReb.js";
import "../../target-errors-BNti0CuM.js";
import "../../chunk-MHyThmdl.js";
import "../../markdown-tables-CPk6MmxS.js";
import "../../local-roots-3Pj1Y1p4.js";
import "../../ir-K7daijXR.js";
import "../../render-B1VqYyvo.js";
import "../../commands-registry-BKICvhNZ.js";
import "../../skill-commands-B4ih5MiE.js";
import "../../runner-BSjO_n_a.js";
import "../../fetch-DPAIXoG3.js";
import "../../channel-activity-DKMy0pAN.js";
import "../../tables-DWMSXRzJ.js";
import "../../send-BPDUHb-8.js";
import "../../outbound-attachment-Bg1sS23C.js";
import "../../send-CahxvUyL.js";
import "../../resolve-route-2W8gOU5l.js";
import "../../proxy-pPaHJt5e.js";
import "../../replies-Dbl7Ar1z.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

//#region src/gateway/boot.ts
function generateBootSessionId() {
	return `boot-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "")}-${crypto.randomUUID().slice(0, 8)}`;
}
const log$1 = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";
function buildBootPrompt(content) {
	return [
		"You are running a boot check. Follow BOOT.md instructions exactly.",
		"",
		"BOOT.md:",
		content,
		"",
		"If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
		"Use the `target` field (not `to`) for message tool destinations.",
		`After sending with the message tool, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
		`If nothing needs attention, reply with ONLY: ${SILENT_REPLY_TOKEN}.`
	].join("\n");
}
async function loadBootFile(workspaceDir) {
	const bootPath = path.join(workspaceDir, BOOT_FILENAME);
	try {
		const trimmed = (await fs.readFile(bootPath, "utf-8")).trim();
		if (!trimmed) return { status: "empty" };
		return {
			status: "ok",
			content: trimmed
		};
	} catch (err) {
		if (err.code === "ENOENT") return { status: "missing" };
		throw err;
	}
}
function snapshotMainSessionMapping(params) {
	const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
	try {
		const entry = loadSessionStore(storePath, { skipCache: true })[params.sessionKey];
		if (!entry) return {
			storePath,
			sessionKey: params.sessionKey,
			canRestore: true,
			hadEntry: false
		};
		return {
			storePath,
			sessionKey: params.sessionKey,
			canRestore: true,
			hadEntry: true,
			entry: structuredClone(entry)
		};
	} catch (err) {
		log$1.debug("boot: could not snapshot main session mapping", {
			sessionKey: params.sessionKey,
			error: String(err)
		});
		return {
			storePath,
			sessionKey: params.sessionKey,
			canRestore: false,
			hadEntry: false
		};
	}
}
async function restoreMainSessionMapping(snapshot) {
	if (!snapshot.canRestore) return;
	try {
		await updateSessionStore(snapshot.storePath, (store) => {
			if (snapshot.hadEntry && snapshot.entry) {
				store[snapshot.sessionKey] = snapshot.entry;
				return;
			}
			delete store[snapshot.sessionKey];
		}, { activeSessionKey: snapshot.sessionKey });
		return;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
async function runBootOnce(params) {
	const bootRuntime = {
		log: () => {},
		error: (message) => log$1.error(String(message)),
		exit: defaultRuntime.exit
	};
	let result;
	try {
		result = await loadBootFile(params.workspaceDir);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log$1.error(`boot: failed to read ${BOOT_FILENAME}: ${message}`);
		return {
			status: "failed",
			reason: message
		};
	}
	if (result.status === "missing" || result.status === "empty") return {
		status: "skipped",
		reason: result.status
	};
	const sessionKey = params.agentId ? resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	}) : resolveMainSessionKey(params.cfg);
	const message = buildBootPrompt(result.content ?? "");
	const sessionId = generateBootSessionId();
	const mappingSnapshot = snapshotMainSessionMapping({
		cfg: params.cfg,
		sessionKey
	});
	let agentFailure;
	try {
		await agentCommand({
			message,
			sessionKey,
			sessionId,
			deliver: false
		}, bootRuntime, params.deps);
	} catch (err) {
		agentFailure = err instanceof Error ? err.message : String(err);
		log$1.error(`boot: agent run failed: ${agentFailure}`);
	}
	const mappingRestoreFailure = await restoreMainSessionMapping(mappingSnapshot);
	if (mappingRestoreFailure) log$1.error(`boot: failed to restore main session mapping: ${mappingRestoreFailure}`);
	if (!agentFailure && !mappingRestoreFailure) return { status: "ran" };
	return {
		status: "failed",
		reason: [agentFailure ? `agent run failed: ${agentFailure}` : void 0, mappingRestoreFailure ? `mapping restore failed: ${mappingRestoreFailure}` : void 0].filter((part) => Boolean(part)).join("; ")
	};
}

//#endregion
//#region src/hooks/bundled/boot-md/handler.ts
const log = createSubsystemLogger("hooks/boot-md");
const runBootChecklist = async (event) => {
	if (!isGatewayStartupEvent(event)) return;
	if (!event.context.cfg) return;
	const cfg = event.context.cfg;
	const deps = event.context.deps ?? createDefaultDeps();
	const agentIds = listAgentIds(cfg);
	for (const agentId of agentIds) {
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const result = await runBootOnce({
			cfg,
			deps,
			workspaceDir,
			agentId
		});
		if (result.status === "failed") {
			log.warn("boot-md failed for agent startup run", {
				agentId,
				workspaceDir,
				reason: result.reason
			});
			continue;
		}
		if (result.status === "skipped") log.debug("boot-md skipped for agent startup run", {
			agentId,
			workspaceDir,
			reason: result.reason
		});
	}
};

//#endregion
export { runBootChecklist as default };