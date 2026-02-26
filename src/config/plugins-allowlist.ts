import type { PowPowConfig } from "./config.js";

export function ensurePluginAllowlisted(cfg: PowPowConfig, pluginId: string): PowPowConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}
