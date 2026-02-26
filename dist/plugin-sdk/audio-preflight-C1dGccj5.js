import "./accounts-DJ8kKC0c.js";
import "./paths-Biw6RtsH.js";
import "./github-copilot-token-CiKFguQ_.js";
import "./plugins-Bi68A-mi.js";
import { $ as logVerbose, nt as shouldLogVerbose } from "./subsystem-BBPkQl8F.js";
import "./config-Beao1DYH.js";
import "./command-format-KJDDAM2E.js";
import "./model-selection-CYqXFRmu.js";
import "./agent-scope-D2mtbkzb.js";
import "./manifest-registry-CPTnK_Gz.js";
import "./dock-Cf78pbDi.js";
import "./redact-WaOJt0Qq.js";
import "./errors-BjJdLum7.js";
import "./fs-safe-B8Ak70Tm.js";
import "./image-ops-B6WDOaEz.js";
import "./ssrf-D7nGqg1W.js";
import "./fetch-guard-Cq9O_7KH.js";
import "./local-roots-BhV_9vuS.js";
import "./message-channel-AVQoV3fs.js";
import "./bindings-C19vfh0Z.js";
import "./tool-images-C-3xgF0t.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, t as buildProviderRegistry, u as isAudioAttachment } from "./runner-Dg9ocKQC.js";
import "./skills-BYiSApWK.js";
import "./chrome-BCWo81Ce.js";
import "./accounts-_7HMFS9m.js";
import "./accounts-BmGno_Wb.js";
import "./sessions-XJKwRHd-.js";
import "./paths-BWCcyYYG.js";
import "./store-CAyXMlC1.js";
import "./pi-embedded-helpers-C2V4TLDX.js";
import "./thinking-BFsWfunr.js";
import "./image-ClYDGNul.js";
import "./pi-model-discovery-B3reDphO.js";
import "./api-key-rotation-DIp0I4yy.js";

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