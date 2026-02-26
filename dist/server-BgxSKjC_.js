import "./paths-Qu8BKDZT.js";
import "./utils-C9Yd70Dr.js";
import "./agent-scope-Coqt3COl.js";
import { t as createSubsystemLogger } from "./subsystem-A8uKC1In.js";
import "./exec-7lv95ExR.js";
import "./model-selection-DAT49TVG.js";
import "./github-copilot-token-oFsuQdhS.js";
import "./boolean-CE7i9tBR.js";
import "./env-BF71IqS7.js";
import "./host-env-security-IP2UsfGZ.js";
import { i as loadConfig } from "./config-ClR1jZcN.js";
import "./env-vars-C_dl05a-.js";
import "./manifest-registry-jY2uQzFh.js";
import "./chrome-ZqtxYayN.js";
import "./tailscale-DSZX1Br_.js";
import "./ip-oUNIYnzv.js";
import "./tailnet-BNQgd2Nt.js";
import "./ws-Bp1n_Uxk.js";
import "./auth-C9bP0Q14.js";
import { i as resolveBrowserConfig, o as ensureBrowserControlAuth, r as registerBrowserRoutes, s as resolveBrowserControlAuth, t as createBrowserRouteContext } from "./server-context-BTpg-KNr.js";
import "./redact-DeH01ocq.js";
import "./errors-Adli4uDW.js";
import "./fs-safe-CW6eaDK2.js";
import "./paths-CTiFSpAD.js";
import "./ssrf-BTTK8Df4.js";
import "./image-ops-DDebYeLI.js";
import "./store-CLQaQ0tz.js";
import "./ports-BB-_Dytw.js";
import "./trash-B0HKkPsm.js";
import { n as installBrowserCommonMiddleware, t as installBrowserAuthMiddleware } from "./server-middleware-BiteXZ6h.js";
import { n as stopKnownBrowserProfiles, t as ensureExtensionRelayForProfiles } from "./server-lifecycle-CHQwpcQ1.js";
import { t as isPwAiLoaded } from "./tool-loop-detection-DFC_vSm8.js";
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
		await (await import("./pw-ai-DAn2stl8.js")).closePlaywrightBrowserConnection();
	} catch {}
}

//#endregion
export { startBrowserControlServerFromConfig, stopBrowserControlServer };