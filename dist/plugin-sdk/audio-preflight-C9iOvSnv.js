import "./accounts-DxYZsuli.js";
import "./paths-Biw6RtsH.js";
import "./github-copilot-token-CiKFguQ_.js";
import "./plugins-CC754RUd.js";
import { $ as logVerbose, nt as shouldLogVerbose } from "./subsystem-s7bDItS2.js";
import "./config-CJwtnumZ.js";
import "./command-format-C8CwhlHn.js";
import "./model-selection--PywJcVq.js";
import "./agent-scope-nFO5sKxo.js";
import "./manifest-registry-C37HxqI3.js";
import "./dock-Xj0fMACU.js";
import "./redact-Cnxjgc1_.js";
import "./errors--0EX9WJt.js";
import "./fs-safe-B8Ak70Tm.js";
import "./image-ops-C1baxN0I.js";
import "./ssrf-D7nGqg1W.js";
import "./fetch-guard-CfqNjBMW.js";
import "./local-roots-BkU_uXsG.js";
import "./message-channel-ConyOfKs.js";
import "./bindings-yzcLThQj.js";
import "./tool-images-Cmv2Jubx.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, t as buildProviderRegistry, u as isAudioAttachment } from "./runner-9DhjdzX4.js";
import "./skills-C9brHyHK.js";
import "./chrome-CgDqxK7T.js";
import "./accounts-BiEUhNas.js";
import "./accounts-C_QCEAiO.js";
import "./sessions-CBtgUEpd.js";
import "./paths-BWCcyYYG.js";
import "./store-W4y68mbT.js";
import "./pi-embedded-helpers-DwUZaTcN.js";
import "./thinking-BFsWfunr.js";
import "./image-Iq-luJuj.js";
import "./pi-model-discovery-B3reDphO.js";
import "./api-key-rotation-DQ1KuR78.js";

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