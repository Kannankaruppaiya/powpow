import "./agent-scope-DxSdR-i1.js";
import "./paths-B4N4CZDb.js";
import { $ as shouldLogVerbose, X as logVerbose } from "./subsystem-J2JHz_PH.js";
import "./model-selection-BIieOTxJ.js";
import "./github-copilot-token-CyuIt22r.js";
import "./env-srzc75vD.js";
import "./plugins-Ce_iB8qK.js";
import "./accounts-B_KDF6-8.js";
import "./bindings-DpEGv8ZL.js";
import "./accounts-Cu0Sdv4U.js";
import "./image-ops-BV6UX3uC.js";
import "./pi-model-discovery-DQnj7CO7.js";
import "./message-channel-Bepl5Nrb.js";
import "./pi-embedded-helpers-BtfCBOnO.js";
import "./config-ctWck2-F.js";
import "./manifest-registry-BxD6c_NV.js";
import "./dock-B0gVk40l.js";
import "./chrome-B9a6n_p9.js";
import "./ssrf-PljZpPCf.js";
import "./skills-jpyWEUPA.js";
import "./redact-DsIiPP8n.js";
import "./errors-D9rAZNPr.js";
import "./fs-safe-C47TU8nv.js";
import "./store-CQH0lIM2.js";
import "./sessions-DEZJJ1nc.js";
import "./accounts-B7X-AzDd.js";
import "./paths-po6dFg-E.js";
import "./tool-images-4k3CXsyz.js";
import "./thinking-BiUfNrGG.js";
import "./image-oFVVIokh.js";
import "./gemini-auth-qMuTTztU.js";
import "./fetch-guard-B94HiDyW.js";
import "./local-roots-B_ohurCO.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, t as buildProviderRegistry, u as isAudioAttachment } from "./runner-BK2IVIT6.js";

//#region src/media-understanding/audio-preflight.ts
/**
* Transcribes the first audio attachment BEFORE mention checking.
* This allows voice notes to be processed in group chats with requireMention: true.
* Returns the transcript or undefined if transcription fails or no audio is found.
*/
async function transcribeFirstAudio(params) {
	const { ctx, cfg } = params;
	const audioConfig = cfg.tools?.media?.audio;
	if (!audioConfig || audioConfig.enabled === false) return;
	const attachments = normalizeMediaAttachments(ctx);
	if (!attachments || attachments.length === 0) return;
	const firstAudio = attachments.find((att) => att && isAudioAttachment(att) && !att.alreadyTranscribed);
	if (!firstAudio) return;
	if (shouldLogVerbose()) logVerbose(`audio-preflight: transcribing attachment ${firstAudio.index} for mention check`);
	const providerRegistry = buildProviderRegistry(params.providers);
	const cache = createMediaAttachmentCache(attachments, { localPathRoots: resolveMediaAttachmentLocalRoots({
		cfg,
		ctx
	}) });
	try {
		const result = await runCapability({
			capability: "audio",
			cfg,
			ctx,
			attachments: cache,
			media: attachments,
			agentDir: params.agentDir,
			providerRegistry,
			config: audioConfig,
			activeModel: params.activeModel
		});
		if (!result || result.outputs.length === 0) return;
		const audioOutput = result.outputs.find((output) => output.kind === "audio.transcription");
		if (!audioOutput || !audioOutput.text) return;
		firstAudio.alreadyTranscribed = true;
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcribed ${audioOutput.text.length} chars from attachment ${firstAudio.index}`);
		return audioOutput.text;
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`audio-preflight: transcription failed: ${String(err)}`);
		return;
	} finally {
		await cache.cleanup();
	}
}

//#endregion
export { transcribeFirstAudio };