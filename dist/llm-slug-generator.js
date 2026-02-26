import { a as resolveAgentEffectiveModelPrimary, c as resolveDefaultAgentId, i as resolveAgentDir, s as resolveAgentWorkspaceDir } from "./agent-scope-rrgzCI7i.js";
import "./paths-T4GVdxf1.js";
import { t as createSubsystemLogger } from "./subsystem-COVUh7Yl.js";
import "./workspace-DqldSWWG.js";
import { it as DEFAULT_PROVIDER, l as parseModelRef, rt as DEFAULT_MODEL } from "./model-selection-CtYSbl7o.js";
import "./github-copilot-token-Cx1zRJ-S.js";
import "./env-LAtE_PJh.js";
import "./boolean-M-esQJt6.js";
import "./tokens-DJZAGCxv.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-BD5y7xgm.js";
import "./plugins-BvsGglJN.js";
import "./accounts-BhpmvulR.js";
import "./bindings-DOq4A-yI.js";
import "./send-piotbg15.js";
import "./send-D26Ob2C_.js";
import "./deliver-CGX-8KOy.js";
import "./diagnostic-DJDaUx6o.js";
import "./diagnostic-session-state-CAjTSaR3.js";
import "./accounts-BTZrFeGN.js";
import "./send-DPQQate4.js";
import "./image-ops-Dvd5i2nB.js";
import "./pi-model-discovery-DZrt2PIy.js";
import "./message-channel-DRH53W01.js";
import "./pi-embedded-helpers-_VurfFiX.js";
import "./config-x2H1-MTw.js";
import "./manifest-registry-C-rdkpms.js";
import "./dock-DV0DMFKc.js";
import "./chrome-DNmCcQ7R.js";
import "./ssrf-CoiLWsBO.js";
import "./frontmatter-BUIiEr_8.js";
import "./skills-DEKqQdxA.js";
import "./redact-PCnzuLf0.js";
import "./errors-CDsFF_uo.js";
import "./fs-safe-DOHEJD7P.js";
import "./store-CGiTyM5w.js";
import "./sessions-CHe4lLyX.js";
import "./accounts-DfIlxzoJ.js";
import "./paths-CfGtSVNo.js";
import "./tool-images-CcUb1sKD.js";
import "./thinking-DWQCK16e.js";
import "./image-pSyUJfmN.js";
import "./reply-prefix-KxhXpghD.js";
import "./manager-BXEZFId-.js";
import "./gemini-auth-COs0BPum.js";
import "./fetch-guard-D835LfDO.js";
import "./query-expansion-DJVvaJPR.js";
import "./retry-CHVPrFtG.js";
import "./target-errors-BKiCqL7C.js";
import "./chunk-vX7zPHaC.js";
import "./markdown-tables-D8BCJQzZ.js";
import "./local-roots-DuvQnRTk.js";
import "./ir-BLw5Y14z.js";
import "./render-B1VqYyvo.js";
import "./commands-registry-Bd8xFyWx.js";
import "./skill-commands-DAlvqj64.js";
import "./runner-DS2jLuPu.js";
import "./fetch-DPAIXoG3.js";
import "./channel-activity-BvDpPnXc.js";
import "./tables-BeLjsUwi.js";
import "./send-BHK10Xiy.js";
import "./outbound-attachment-BpQJ9NFn.js";
import "./send-BaIxaQtr.js";
import "./resolve-route-BJP5lTij.js";
import "./proxy-pPaHJt5e.js";
import "./replies-BPml4ZIC.js";
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