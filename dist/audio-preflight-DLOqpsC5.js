import "./paths-BJtes5yu.js";
import "./subsystem-DXlyH4H4.js";
import { P as shouldLogVerbose, j as logVerbose } from "./utils-BWJH7VRh.js";
import "./boolean-YY6K2DFz.js";
import "./auth-profiles-KPMal-k-.js";
import "./agent-scope-Ac0Vygcn.js";
import "./exec-Du-v-jcI.js";
import "./github-copilot-token-CgHPGmmS.js";
import "./host-env-security-DkeGvzp3.js";
import "./pi-model-discovery-Do3xMEtM.js";
import "./frontmatter-B7nss1o8.js";
import "./skills-D7zMUUWl.js";
import "./manifest-registry-C9O9KUb3.js";
import "./config-B91e8u6L.js";
import "./env-vars-D53NnL-N.js";
import "./dock-DaMhmHr_.js";
import "./message-channel-DYK7E7vt.js";
import "./sessions-DGKLiJDU.js";
import "./plugins-CPaMeorQ.js";
import "./accounts-CafntguV.js";
import "./accounts--1-XHGvw.js";
import "./accounts-DUEZIYFu.js";
import "./bindings-B0Nfghiw.js";
import "./logging-D-Jq2wIo.js";
import "./paths-BB4B9o0x.js";
import "./chat-envelope-9mWFsNOQ.js";
import "./net-CliLiAjH.js";
import "./ip-cpmUu6M4.js";
import "./tailnet-DVxZdYPM.js";
import "./image-ops-BsCVl39S.js";
import "./pi-embedded-helpers-DWdt6mA4.js";
import "./sandbox-Vr4z2IvO.js";
import "./tool-catalog-7y19qjm_.js";
import "./chrome-CwN6j-nF.js";
import "./tailscale-Mny9GO9e.js";
import "./auth-BQr6HjtW.js";
import "./server-context-B-VoITNb.js";
import "./redact-CAjBvpi8.js";
import "./errors-BpyuHard.js";
import "./fs-safe-CEkqp78T.js";
import "./paths-B2BIhK5k.js";
import "./ssrf-AiRrlY78.js";
import "./store-DBQ7ewOG.js";
import "./ports-61DuVTUr.js";
import "./trash-BnkU_HL9.js";
import "./server-middleware-D1hQIx0O.js";
import "./tool-images-B1e7Ffhh.js";
import "./thinking-CJPPUYWd.js";
import "./models-config-CQKypJwH.js";
import "./gemini-auth-DjnSSvsE.js";
import "./fetch-guard-BfYhc_DT.js";
import "./local-roots-CzyKzdf9.js";
import "./image-29CasYKc.js";
import "./tool-display-DYQmKeWr.js";
import { a as resolveMediaAttachmentLocalRoots, n as createMediaAttachmentCache, o as runCapability, r as normalizeMediaAttachments, s as isAudioAttachment, t as buildProviderRegistry } from "./runner-DY7HbTfW.js";
import "./model-catalog-ExB4NYZv.js";

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