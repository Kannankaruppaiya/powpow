import "./paths-Qu8BKDZT.js";
import { B as theme } from "./utils-C9Yd70Dr.js";
import "./thinking-EAliFiVK.js";
import "./agent-scope-Coqt3COl.js";
import { f as defaultRuntime } from "./subsystem-A8uKC1In.js";
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
import "./commands-D0moBlUA.js";
import "./commands-registry-em8AeoGs.js";
import "./client-CqOX5C6i.js";
import "./call-VpiD4sCY.js";
import "./pairing-token-DGnZq89k.js";
import { t as formatDocsLink } from "./links-DloDafB-.js";
import { t as parseTimeoutMs } from "./parse-timeout-ntOahNdf.js";
import { t as runTui } from "./tui-DL8NIDeG.js";

//#region src/cli/tui-cli.ts
function registerTuiCli(program) {
	program.command("tui").description("Open a terminal UI connected to the Gateway").option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (if required)").option("--session <key>", "Session key (default: \"main\", or \"global\" when scope is global)").option("--deliver", "Deliver assistant replies", false).option("--thinking <level>", "Thinking level override").option("--message <text>", "Send an initial message after connecting").option("--timeout-ms <ms>", "Agent timeout in ms (defaults to agents.defaults.timeoutSeconds)").option("--history-limit <n>", "History entries to load", "200").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/tui", "docs.PowPow.ai/cli/tui")}\n`).action(async (opts) => {
		try {
			const timeoutMs = parseTimeoutMs(opts.timeoutMs);
			if (opts.timeoutMs !== void 0 && timeoutMs === void 0) defaultRuntime.error(`warning: invalid --timeout-ms "${String(opts.timeoutMs)}"; ignoring`);
			const historyLimit = Number.parseInt(String(opts.historyLimit ?? "200"), 10);
			await runTui({
				url: opts.url,
				token: opts.token,
				password: opts.password,
				session: opts.session,
				deliver: Boolean(opts.deliver),
				thinking: opts.thinking,
				message: opts.message,
				timeoutMs,
				historyLimit: Number.isNaN(historyLimit) ? void 0 : historyLimit
			});
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
export { registerTuiCli };