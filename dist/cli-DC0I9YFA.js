import "./paths-Qu8BKDZT.js";
import "./utils-C9Yd70Dr.js";
import "./thinking-EAliFiVK.js";
import { _t as loadPowPowPlugins } from "./reply-DXKoJPvW.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-Coqt3COl.js";
import { t as createSubsystemLogger } from "./subsystem-A8uKC1In.js";
import "./exec-7lv95ExR.js";
import "./model-selection-DAT49TVG.js";
import "./github-copilot-token-oFsuQdhS.js";
import "./boolean-CE7i9tBR.js";
import "./env-BF71IqS7.js";
import "./host-env-security-IP2UsfGZ.js";
import "./message-channel-Bc5gLV-e.js";
import "./send-BYGkmhGE.js";
import { i as loadConfig } from "./config-ClR1jZcN.js";
import "./env-vars-C_dl05a-.js";
import "./manifest-registry-jY2uQzFh.js";
import "./dock-Dwi_4IIN.js";
import "./runner-D5ewLVko.js";
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
import "./send-DeB59idg.js";
import "./paths-Da74Udq3.js";
import "./chat-envelope-Cy_2InG3.js";
import "./tool-images-ckH00w02.js";
import "./tool-display-q2tmuqK_.js";
import "./fetch-guard-C82rfIQY.js";
import "./api-key-rotation-ic-5DL61.js";
import "./local-roots-DMThNrwL.js";
import "./query-expansion-Br_BoAqE.js";
import "./model-catalog-BzI947Bm.js";
import "./tokens-UHDe-szI.js";
import "./deliver-Bg5q3LiJ.js";
import "./commands-D0moBlUA.js";
import "./commands-registry-em8AeoGs.js";
import "./pairing-store-BSzGxPBw.js";
import "./fetch-D3h8BpE_.js";
import "./retry--8gFlsEJ.js";
import "./client-CqOX5C6i.js";
import "./call-VpiD4sCY.js";
import "./pairing-token-DGnZq89k.js";
import "./exec-approvals-BkW3pw1J.js";
import "./exec-approvals-allowlist-wGY6Lw3S.js";
import "./exec-safe-bin-runtime-policy-DmM-sEYp.js";
import "./nodes-screen-bqra0Nic.js";
import "./target-errors-DAPaOqD8.js";
import "./diagnostic-session-state-pvX9RRTI.js";
import "./with-timeout-CgqZfOEc.js";
import "./diagnostic-CU3swLzM.js";
import "./send-qkxnhFdm.js";
import "./model-BF_Y_g2C.js";
import "./reply-prefix-4xFugQQN.js";
import "./memory-cli-CRELyYWA.js";
import "./manager-3gjRJ1oN.js";
import "./chunk-DEySYRr3.js";
import "./markdown-tables-iuOnj7Cl.js";
import "./ir-BIBAnr1T.js";
import "./render-C1H8wE-4.js";
import "./channel-activity-DFMOrq2l.js";
import "./tables-zzWSbOhs.js";
import "./send-XwYIpXfx.js";
import "./proxy-BKYeJKIM.js";
import "./links-DloDafB-.js";
import "./cli-utils-1c5fmOOR.js";
import "./help-format-FvjEYf8n.js";
import "./progress-B2zqIvBy.js";
import "./resolve-route-DeMT-IKg.js";
import "./pi-tools.policy-B2x6Vkrw.js";
import "./replies-CY9V0djK.js";
import "./skill-commands-DfIg5HmH.js";
import "./workspace-dirs-BRTADMtx.js";
import "./plugin-auto-enable-DRupPcLz.js";
import "./channel-selection-peliUZX-.js";
import "./outbound-attachment-3ij3wVzH.js";
import "./delivery-queue-COKfH9xd.js";
import "./session-cost-usage-DH0GdlRS.js";
import "./send-CXjb9Q1N.js";
import "./onboard-helpers-D8_1U5gk.js";
import "./prompt-style-DP-Eq7qJ.js";
import "./pairing-labels-Bil8jyxp.js";
import "./server-lifecycle-CHQwpcQ1.js";
import "./stagger-RKJcYQbS.js";

//#region src/plugins/cli.ts
const log = createSubsystemLogger("plugins");
function registerPluginCliCommands(program, cfg) {
	const config = cfg ?? loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	const logger = {
		info: (msg) => log.info(msg),
		warn: (msg) => log.warn(msg),
		error: (msg) => log.error(msg),
		debug: (msg) => log.debug(msg)
	};
	const registry = loadPowPowPlugins({
		config,
		workspaceDir,
		logger
	});
	const existingCommands = new Set(program.commands.map((cmd) => cmd.name()));
	for (const entry of registry.cliRegistrars) {
		if (entry.commands.length > 0) {
			const overlaps = entry.commands.filter((command) => existingCommands.has(command));
			if (overlaps.length > 0) {
				log.debug(`plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(", ")})`);
				continue;
			}
		}
		try {
			const result = entry.register({
				program,
				config,
				workspaceDir,
				logger
			});
			if (result && typeof result.then === "function") result.catch((err) => {
				log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
			});
			for (const command of entry.commands) existingCommands.add(command);
		} catch (err) {
			log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
		}
	}
}

//#endregion
export { registerPluginCliCommands };