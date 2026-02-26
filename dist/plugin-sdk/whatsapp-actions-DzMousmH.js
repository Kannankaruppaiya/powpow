import { i as resolveWhatsAppAccount } from "./accounts-DxYZsuli.js";
import "./paths-Biw6RtsH.js";
import "./github-copilot-token-CiKFguQ_.js";
import "./plugins-CC754RUd.js";
import "./subsystem-s7bDItS2.js";
import "./config-CJwtnumZ.js";
import "./command-format-C8CwhlHn.js";
import "./model-selection--PywJcVq.js";
import "./agent-scope-nFO5sKxo.js";
import "./manifest-registry-C37HxqI3.js";
import "./fs-safe-B8Ak70Tm.js";
import "./image-ops-C1baxN0I.js";
import "./ssrf-D7nGqg1W.js";
import "./fetch-guard-CfqNjBMW.js";
import "./local-roots-BkU_uXsG.js";
import "./ir-Df16PE0C.js";
import "./chunk-C4xahrCG.js";
import "./message-channel-ConyOfKs.js";
import "./bindings-yzcLThQj.js";
import "./markdown-tables-CSgaWdPy.js";
import "./render-DzUFCfck.js";
import "./tables-D-1CX2bV.js";
import "./tool-images-Cmv2Jubx.js";
import { a as createActionGate, c as jsonResult, d as readReactionParams, i as ToolAuthorizationError, m as readStringParam } from "./target-errors-CIaYc0E8.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-B-rnR82o.js";
import { r as sendReactionWhatsApp } from "./outbound-H3WaJCOG.js";

//#region src/agents/tools/whatsapp-target-auth.ts
function resolveAuthorizedWhatsAppOutboundTarget(params) {
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const resolution = resolveWhatsAppOutboundTarget({
		to: params.chatJid,
		allowFrom: account.allowFrom ?? [],
		mode: "implicit"
	});
	if (!resolution.ok) throw new ToolAuthorizationError(`WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not in the configured allowFrom list for account "${account.accountId}".`);
	return {
		to: resolution.to,
		accountId: account.accountId
	};
}

//#endregion
//#region src/agents/tools/whatsapp-actions.ts
async function handleWhatsAppAction(params, cfg) {
	const action = readStringParam(params, "action", { required: true });
	const isActionEnabled = createActionGate(cfg.channels?.whatsapp?.actions);
	if (action === "react") {
		if (!isActionEnabled("reactions")) throw new Error("WhatsApp reactions are disabled.");
		const chatJid = readStringParam(params, "chatJid", { required: true });
		const messageId = readStringParam(params, "messageId", { required: true });
		const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a WhatsApp reaction." });
		const participant = readStringParam(params, "participant");
		const accountId = readStringParam(params, "accountId");
		const fromMeRaw = params.fromMe;
		const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : void 0;
		const resolved = resolveAuthorizedWhatsAppOutboundTarget({
			cfg,
			chatJid,
			accountId,
			actionLabel: "reaction"
		});
		const resolvedEmoji = remove ? "" : emoji;
		await sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
			verbose: false,
			fromMe,
			participant: participant ?? void 0,
			accountId: resolved.accountId
		});
		if (!remove && !isEmpty) return jsonResult({
			ok: true,
			added: emoji
		});
		return jsonResult({
			ok: true,
			removed: true
		});
	}
	throw new Error(`Unsupported WhatsApp action: ${action}`);
}

//#endregion
export { handleWhatsAppAction };