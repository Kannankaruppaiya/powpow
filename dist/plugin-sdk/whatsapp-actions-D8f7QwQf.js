import { i as resolveWhatsAppAccount } from "./accounts-DJ8kKC0c.js";
import "./paths-Biw6RtsH.js";
import "./github-copilot-token-CiKFguQ_.js";
import "./plugins-Bi68A-mi.js";
import "./subsystem-BBPkQl8F.js";
import "./config-Beao1DYH.js";
import "./command-format-KJDDAM2E.js";
import "./model-selection-CYqXFRmu.js";
import "./agent-scope-D2mtbkzb.js";
import "./manifest-registry-CPTnK_Gz.js";
import "./fs-safe-B8Ak70Tm.js";
import "./image-ops-B6WDOaEz.js";
import "./ssrf-D7nGqg1W.js";
import "./fetch-guard-Cq9O_7KH.js";
import "./local-roots-BhV_9vuS.js";
import "./ir-BLaXyoxv.js";
import "./chunk-Cx8UzZ-K.js";
import "./message-channel-AVQoV3fs.js";
import "./bindings-C19vfh0Z.js";
import "./markdown-tables-DzmZ80K9.js";
import "./render-DzUFCfck.js";
import "./tables-Bxff7UTZ.js";
import "./tool-images-C-3xgF0t.js";
import { a as createActionGate, c as jsonResult, d as readReactionParams, i as ToolAuthorizationError, m as readStringParam } from "./target-errors-CCfQj0EI.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-BRRsAF7i.js";
import { r as sendReactionWhatsApp } from "./outbound-PEirmRGB.js";

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