import "./paths-BJtes5yu.js";
import { f as defaultRuntime } from "./subsystem-DXlyH4H4.js";
import { z as theme } from "./utils-BWJH7VRh.js";
import "./boolean-YY6K2DFz.js";
import "./auth-profiles-KPMal-k-.js";
import "./agent-scope-Ac0Vygcn.js";
import "./exec-Du-v-jcI.js";
import "./github-copilot-token-CgHPGmmS.js";
import "./host-env-security-DkeGvzp3.js";
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
import "./client-FngVpCQH.js";
import "./call-Dy4jPY6_.js";
import "./pairing-token-DdQlEK2o.js";
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
import "./commands-BVUHpNuP.js";
import "./commands-registry-5aQe-nwe.js";
import "./tool-display-DYQmKeWr.js";
import { t as parseTimeoutMs } from "./parse-timeout-CuYdP9TL.js";
import { t as formatDocsLink } from "./links-C00eySj4.js";
import { t as runTui } from "./tui-CSjabyxT.js";

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