import "./paths-Qu8BKDZT.js";
import "./utils-C9Yd70Dr.js";
import "./agent-scope-Coqt3COl.js";
import "./subsystem-A8uKC1In.js";
import "./exec-7lv95ExR.js";
import "./model-selection-DAT49TVG.js";
import "./github-copilot-token-oFsuQdhS.js";
import "./boolean-CE7i9tBR.js";
import "./env-BF71IqS7.js";
import "./host-env-security-IP2UsfGZ.js";
import "./message-channel-Bc5gLV-e.js";
import "./config-ClR1jZcN.js";
import "./env-vars-C_dl05a-.js";
import "./manifest-registry-jY2uQzFh.js";
import "./ip-oUNIYnzv.js";
import "./fs-safe-CW6eaDK2.js";
import "./ssrf-BTTK8Df4.js";
import "./image-ops-DDebYeLI.js";
import { a as isWhatsAppGroupJid, o as normalizeWhatsAppTarget } from "./plugins-rCyIPzMG.js";
import { i as resolveWhatsAppAccount } from "./accounts-CWi8B8Jm.js";
import "./bindings-CmitqUAt.js";
import "./logging-xYH6GmRT.js";
import "./tool-images-ckH00w02.js";
import "./fetch-guard-C82rfIQY.js";
import "./local-roots-DMThNrwL.js";
import { f as readReactionParams, h as readStringParam, i as ToolAuthorizationError, l as jsonResult, n as missingTargetError, o as createActionGate } from "./target-errors-DAPaOqD8.js";
import "./chunk-DEySYRr3.js";
import "./markdown-tables-iuOnj7Cl.js";
import "./ir-BIBAnr1T.js";
import "./render-C1H8wE-4.js";
import "./tables-zzWSbOhs.js";
import { r as sendReactionWhatsApp } from "./outbound-B6cQE3XD.js";

//#region src/whatsapp/resolve-outbound-target.ts
function resolveWhatsAppOutboundTarget(params) {
	const trimmed = params.to?.trim() ?? "";
	const allowListRaw = (params.allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
	const hasWildcard = allowListRaw.includes("*");
	const allowList = allowListRaw.filter((entry) => entry !== "*").map((entry) => normalizeWhatsAppTarget(entry)).filter((entry) => Boolean(entry));
	if (trimmed) {
		const normalizedTo = normalizeWhatsAppTarget(trimmed);
		if (!normalizedTo) return {
			ok: false,
			error: missingTargetError("WhatsApp", "<E.164|group JID>")
		};
		if (isWhatsAppGroupJid(normalizedTo)) return {
			ok: true,
			to: normalizedTo
		};
		if (hasWildcard || allowList.length === 0) return {
			ok: true,
			to: normalizedTo
		};
		if (allowList.includes(normalizedTo)) return {
			ok: true,
			to: normalizedTo
		};
		return {
			ok: false,
			error: missingTargetError("WhatsApp", "<E.164|group JID>")
		};
	}
	return {
		ok: false,
		error: missingTargetError("WhatsApp", "<E.164|group JID>")
	};
}

//#endregion
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