import "./paths-BJtes5yu.js";
import { f as defaultRuntime } from "./subsystem-DXlyH4H4.js";
import { D as danger, z as theme } from "./utils-BWJH7VRh.js";
import "./boolean-YY6K2DFz.js";
import "./auth-profiles-KPMal-k-.js";
import "./agent-scope-Ac0Vygcn.js";
import "./exec-Du-v-jcI.js";
import "./github-copilot-token-CgHPGmmS.js";
import "./host-env-security-DkeGvzp3.js";
import "./manifest-registry-C9O9KUb3.js";
import "./config-B91e8u6L.js";
import "./env-vars-D53NnL-N.js";
import "./message-channel-DYK7E7vt.js";
import "./client-FngVpCQH.js";
import "./call-Dy4jPY6_.js";
import "./pairing-token-DdQlEK2o.js";
import "./net-CliLiAjH.js";
import "./ip-cpmUu6M4.js";
import "./tailnet-DVxZdYPM.js";
import { t as formatDocsLink } from "./links-C00eySj4.js";
import "./progress-DF7PrFZS.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-CB5mPCiK.js";

//#region src/cli/system-cli.ts
const normalizeWakeMode = (raw) => {
	const mode = typeof raw === "string" ? raw.trim() : "";
	if (!mode) return "next-heartbeat";
	if (mode === "now" || mode === "next-heartbeat") return mode;
	throw new Error("--mode must be now or next-heartbeat");
};
async function runSystemGatewayCommand(opts, action, successText) {
	try {
		const result = await action();
		if (opts.json || successText === void 0) defaultRuntime.log(JSON.stringify(result, null, 2));
		else defaultRuntime.log(successText);
	} catch (err) {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	}
}
function registerSystemCli(program) {
	const system = program.command("system").description("System tools (events, heartbeat, presence)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/system", "docs.PowPow.ai/cli/system")}\n`);
	addGatewayClientOptions(system.command("event").description("Enqueue a system event and optionally trigger a heartbeat").requiredOption("--text <text>", "System event text").option("--mode <mode>", "Wake mode (now|next-heartbeat)", "next-heartbeat").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			const text = typeof opts.text === "string" ? opts.text.trim() : "";
			if (!text) throw new Error("--text is required");
			return await callGatewayFromCli("wake", opts, {
				mode: normalizeWakeMode(opts.mode),
				text
			}, { expectFinal: false });
		}, "ok");
	});
	const heartbeat = system.command("heartbeat").description("Heartbeat controls");
	addGatewayClientOptions(heartbeat.command("last").description("Show the last heartbeat event").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("last-heartbeat", opts, void 0, { expectFinal: false });
		});
	});
	addGatewayClientOptions(heartbeat.command("enable").description("Enable heartbeats").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("set-heartbeats", opts, { enabled: true }, { expectFinal: false });
		});
	});
	addGatewayClientOptions(heartbeat.command("disable").description("Disable heartbeats").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("set-heartbeats", opts, { enabled: false }, { expectFinal: false });
		});
	});
	addGatewayClientOptions(system.command("presence").description("List system presence entries").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("system-presence", opts, void 0, { expectFinal: false });
		});
	});
}

//#endregion
export { registerSystemCli };