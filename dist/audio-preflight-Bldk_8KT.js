import "./paths-Qu8BKDZT.js";
import { F as shouldLogVerbose, M as logVerbose } from "./utils-C9Yd70Dr.js";
import "./thinking-EAliFiVK.js";
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
import "./dock-Dwi_4IIN.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, s as isAudioAttachment, t as buildProviderRegistry } from "./runner-D5ewLVko.js";
import "./image-BKPBLVoT.js";
import "./models-config-Ds7_Vwbp.js";
import "./pi-model-discovery-DOnkTbEw.js";
import "./pi-embedded-helpers-4ySZ3wEh.js";
import "./sandbox-5vw3WOI7.js";
import "./tool-catalog-aVpRTkDA.js";
import "./chrome-ZqtxYayN.js";
import "./tailscale-DSZX1Br_.js";
import "./ip-oUNIYnzv.js";
import "./tailnet-BNQgd2Nt.js";
import "./ws-Bp1n_Uxk.js";
import "./auth-C9bP0Q14.js";
import "./server-context-BTpg-KNr.js";
import "./frontmatter-D24yp6Oh.js";
import "./skills-CpGz3h87.js";
import "./redact-DeH01ocq.js";
import "./errors-Adli4uDW.js";
import "./fs-safe-CW6eaDK2.js";
import "./paths-CTiFSpAD.js";
import "./ssrf-BTTK8Df4.js";
import "./image-ops-DDebYeLI.js";
import "./store-CLQaQ0tz.js";
import "./ports-BB-_Dytw.js";
import "./trash-B0HKkPsm.js";
import "./server-middleware-BiteXZ6h.js";
import "./sessions-fBW7dZrm.js";
import "./plugins-rCyIPzMG.js";
import "./accounts-CWi8B8Jm.js";
import "./accounts-BKSPewAC.js";
import "./accounts-DCHDHCEc.js";
import "./bindings-CmitqUAt.js";
import "./logging-xYH6GmRT.js";
import "./paths-Da74Udq3.js";
import "./chat-envelope-Cy_2InG3.js";
import "./tool-images-ckH00w02.js";
import "./tool-display-q2tmuqK_.js";
import "./fetch-guard-C82rfIQY.js";
import "./api-key-rotation-ic-5DL61.js";
import "./local-roots-DMThNrwL.js";
import "./model-catalog-BzI947Bm.js";

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