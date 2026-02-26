import "./agent-scope-LV16AGcF.js";
import "./paths-DGhxxd_R.js";
import { $ as shouldLogVerbose, X as logVerbose } from "./subsystem-3xhEFOyH.js";
import "./workspace-BbD3Kass.js";
import "./model-selection-MeurW_4a.js";
import "./github-copilot-token-BLvi1M0g.js";
import "./env-dg1Vq6R_.js";
import "./boolean-M-esQJt6.js";
import "./plugins-toi-1uUy.js";
import "./accounts-B3jyVzHI.js";
import "./bindings-6AsTw9R5.js";
import "./accounts-CDbVneGZ.js";
import "./image-ops-CIlRVMHI.js";
import "./pi-model-discovery-DZrt2PIy.js";
import "./message-channel-D_VJsPCS.js";
import "./pi-embedded-helpers-BXcYGfm7.js";
import "./config-BVY11kC2.js";
import "./manifest-registry-R4d8uSqf.js";
import "./dock-CU6BAEqI.js";
import "./chrome-DPYX8bg6.js";
import "./ssrf-CoiLWsBO.js";
import "./frontmatter-CM2DP0fv.js";
import "./skills-DBJQT9jY.js";
import "./redact-Bu0ABJUw.js";
import "./errors-WCORuQlU.js";
import "./fs-safe-DOHEJD7P.js";
import "./store-CqI0-rwc.js";
import "./sessions-BYz6utTL.js";
import "./accounts-B7R1IsiZ.js";
import "./paths-CqAHUYfl.js";
import "./tool-images-CMt0Ll63.js";
import "./thinking-DWQCK16e.js";
import "./image-BIA1_Uyx.js";
import "./gemini-auth-BXgwGHBK.js";
import "./fetch-guard-ZpIM9DWw.js";
import "./local-roots-3Pj1Y1p4.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, t as buildProviderRegistry, u as isAudioAttachment } from "./runner-BSjO_n_a.js";

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