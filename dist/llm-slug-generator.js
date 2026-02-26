import { a as resolveAgentEffectiveModelPrimary, c as resolveDefaultAgentId, i as resolveAgentDir, s as resolveAgentWorkspaceDir } from "./agent-scope-LV16AGcF.js";
import "./paths-DGhxxd_R.js";
import { t as createSubsystemLogger } from "./subsystem-3xhEFOyH.js";
import "./workspace-BbD3Kass.js";
import { it as DEFAULT_PROVIDER, l as parseModelRef, rt as DEFAULT_MODEL } from "./model-selection-MeurW_4a.js";
import "./github-copilot-token-BLvi1M0g.js";
import "./env-dg1Vq6R_.js";
import "./boolean-M-esQJt6.js";
import "./tokens-CME7a42x.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-Dsj2-Den.js";
import "./plugins-toi-1uUy.js";
import "./accounts-B3jyVzHI.js";
import "./bindings-6AsTw9R5.js";
import "./send-CIPI7zkP.js";
import "./send-QVHUX4ZV.js";
import "./deliver-D5tmcHzs.js";
import "./diagnostic-C7jULjsI.js";
import "./diagnostic-session-state-CAjTSaR3.js";
import "./accounts-CDbVneGZ.js";
import "./send-CJBL10K3.js";
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
import "./reply-prefix-BOxoO1Ns.js";
import "./manager-BW9ulmNk.js";
import "./gemini-auth-BXgwGHBK.js";
import "./fetch-guard-ZpIM9DWw.js";
import "./query-expansion-B7aQNYg9.js";
import "./retry-B6tUuReb.js";
import "./target-errors-BNti0CuM.js";
import "./chunk-MHyThmdl.js";
import "./markdown-tables-CPk6MmxS.js";
import "./local-roots-3Pj1Y1p4.js";
import "./ir-K7daijXR.js";
import "./render-B1VqYyvo.js";
import "./commands-registry-BKICvhNZ.js";
import "./skill-commands-B4ih5MiE.js";
import "./runner-BSjO_n_a.js";
import "./fetch-DPAIXoG3.js";
import "./channel-activity-DKMy0pAN.js";
import "./tables-DWMSXRzJ.js";
import "./send-BPDUHb-8.js";
import "./outbound-attachment-Bg1sS23C.js";
import "./send-CahxvUyL.js";
import "./resolve-route-2W8gOU5l.js";
import "./proxy-pPaHJt5e.js";
import "./replies-Dbl7Ar1z.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

//#region src/hooks/llm-slug-generator.ts
/**
* LLM-based slug generator for session memory filenames
*/
const log = createSubsystemLogger("llm-slug-generator");
/**
* Generate a short 1-2 word filename slug from session content using LLM
*/
async function generateSlugViaLLM(params) {
	let tempSessionFile = null;
	try {
		const agentId = resolveDefaultAgentId(params.cfg);
		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
		const agentDir = resolveAgentDir(params.cfg, agentId);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "powpow-slug-"));
		tempSessionFile = path.join(tempDir, "session.jsonl");
		const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, 2e3)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;
		const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, agentId);
		const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
		const provider = parsed?.provider ?? DEFAULT_PROVIDER;
		const model = parsed?.model ?? DEFAULT_MODEL;
		const result = await runEmbeddedPiAgent({
			sessionId: `slug-generator-${Date.now()}`,
			sessionKey: "temp:slug-generator",
			agentId,
			sessionFile: tempSessionFile,
			workspaceDir,
			agentDir,
			config: params.cfg,
			prompt,
			provider,
			model,
			timeoutMs: 15e3,
			runId: `slug-gen-${Date.now()}`
		});
		if (result.payloads && result.payloads.length > 0) {
			const text = result.payloads[0]?.text;
			if (text) return text.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || null;
		}
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.stack ?? err.message : String(err);
		log.error(`Failed to generate slug: ${message}`);
		return null;
	} finally {
		if (tempSessionFile) try {
			await fs.rm(path.dirname(tempSessionFile), {
				recursive: true,
				force: true
			});
		} catch {}
	}
}

//#endregion
export { generateSlugViaLLM };