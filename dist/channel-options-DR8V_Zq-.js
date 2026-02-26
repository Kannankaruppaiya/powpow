import { v as CHAT_CHANNEL_ORDER } from "./subsystem-A8uKC1In.js";
import { t as isTruthyEnvValue } from "./env-BF71IqS7.js";
import { n as listChannelPlugins } from "./plugins-rCyIPzMG.js";
import { a as listChannelPluginCatalogEntries } from "./plugin-auto-enable-DRupPcLz.js";
import { t as ensurePluginRegistryLoaded } from "./plugin-registry-BsxhYVsm.js";

//#region src/cli/channel-options.ts
function dedupe(values) {
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		resolved.push(value);
	}
	return resolved;
}
function resolveCliChannelOptions() {
	const catalog = listChannelPluginCatalogEntries().map((entry) => entry.id);
	const base = dedupe([...CHAT_CHANNEL_ORDER, ...catalog]);
	if (isTruthyEnvValue(process.env.POWPOW_EAGER_CHANNEL_OPTIONS)) {
		ensurePluginRegistryLoaded();
		const pluginIds = listChannelPlugins().map((plugin) => plugin.id);
		return dedupe([...base, ...pluginIds]);
	}
	return base;
}
function formatCliChannelOptions(extra = []) {
	return [...extra, ...resolveCliChannelOptions()].join("|");
}

//#endregion
export { resolveCliChannelOptions as n, formatCliChannelOptions as t };