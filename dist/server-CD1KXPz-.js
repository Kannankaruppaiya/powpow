import "./paths-BJtes5yu.js";
import { t as createSubsystemLogger } from "./subsystem-DXlyH4H4.js";
import "./utils-BWJH7VRh.js";
import "./boolean-YY6K2DFz.js";
import "./auth-profiles-KPMal-k-.js";
import "./agent-scope-Ac0Vygcn.js";
import "./exec-Du-v-jcI.js";
import "./github-copilot-token-CgHPGmmS.js";
import "./host-env-security-DkeGvzp3.js";
import "./manifest-registry-C9O9KUb3.js";
import { i as loadConfig } from "./config-B91e8u6L.js";
import "./env-vars-D53NnL-N.js";
import "./net-CliLiAjH.js";
import "./ip-cpmUu6M4.js";
import "./tailnet-DVxZdYPM.js";
import "./image-ops-BsCVl39S.js";
import "./chrome-CwN6j-nF.js";
import "./tailscale-Mny9GO9e.js";
import "./auth-BQr6HjtW.js";
import { i as resolveBrowserConfig, o as ensureBrowserControlAuth, r as registerBrowserRoutes, s as resolveBrowserControlAuth, t as createBrowserRouteContext } from "./server-context-B-VoITNb.js";
import "./redact-CAjBvpi8.js";
import "./errors-BpyuHard.js";
import "./fs-safe-CEkqp78T.js";
import "./paths-B2BIhK5k.js";
import "./ssrf-AiRrlY78.js";
import "./store-DBQ7ewOG.js";
import "./ports-61DuVTUr.js";
import "./trash-BnkU_HL9.js";
import { n as installBrowserCommonMiddleware, t as installBrowserAuthMiddleware } from "./server-middleware-D1hQIx0O.js";
import { n as stopKnownBrowserProfiles, t as ensureExtensionRelayForProfiles } from "./server-lifecycle-Bjvkjvkd.js";
import { t as isPwAiLoaded } from "./tool-loop-detection-DjAZW14L.js";
import express from "express";

//#region src/browser/server.ts
let state = null;
const logServer = createSubsystemLogger("browser").child("server");
async function startBrowserControlServerFromConfig() {
	if (state) return state;
	const cfg = loadConfig();
	const resolved = resolveBrowserConfig(cfg.browser, cfg);
	if (!resolved.enabled) return null;
	let browserAuth = resolveBrowserControlAuth(cfg);
	try {
		const ensured = await ensureBrowserControlAuth({ cfg });
		browserAuth = ensured.auth;
		if (ensured.generatedToken) logServer.info("No browser auth configured; generated gateway.auth.token automatically.");
	} catch (err) {
		logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
	}
	const app = express();
	installBrowserCommonMiddleware(app);
	installBrowserAuthMiddleware(app, browserAuth);
	registerBrowserRoutes(app, createBrowserRouteContext({
		getState: () => state,
		refreshConfigFromDisk: true
	}));
	const port = resolved.controlPort;
	const server = await new Promise((resolve, reject) => {
		const s = app.listen(port, "127.0.0.1", () => resolve(s));
		s.once("error", reject);
	}).catch((err) => {
		logServer.error(`PowPow browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
		return null;
	});
	if (!server) return null;
	state = {
		server,
		port,
		resolved,
		profiles: /* @__PURE__ */ new Map()
	};
	await ensureExtensionRelayForProfiles({
		resolved,
		onWarn: (message) => logServer.warn(message)
	});
	const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
	logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
	return state;
}
async function stopBrowserControlServer() {
	const current = state;
	if (!current) return;
	await stopKnownBrowserProfiles({
		getState: () => state,
		onWarn: (message) => logServer.warn(message)
	});
	if (current.server) await new Promise((resolve) => {
		current.server?.close(() => resolve());
	});
	state = null;
	if (isPwAiLoaded()) try {
		await (await import("./pw-ai-Bavn-ChS.js")).closePlaywrightBrowserConnection();
	} catch {}
}

//#endregion
export { startBrowserControlServerFromConfig, stopBrowserControlServer };