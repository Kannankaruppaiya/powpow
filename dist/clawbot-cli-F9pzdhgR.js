import "./paths-BJtes5yu.js";
import "./subsystem-DXlyH4H4.js";
import { z as theme } from "./utils-BWJH7VRh.js";
import "./boolean-YY6K2DFz.js";
import "./auth-profiles-KPMal-k-.js";
import "./agent-scope-Ac0Vygcn.js";
import "./exec-Du-v-jcI.js";
import "./github-copilot-token-CgHPGmmS.js";
import "./host-env-security-DkeGvzp3.js";
import "./manifest-registry-C9O9KUb3.js";
import "./config-B91e8u6L.js";
import "./env-vars-D53NnL-N.js";
import "./ip-cpmUu6M4.js";
import { t as formatDocsLink } from "./links-C00eySj4.js";
import { n as registerQrCli } from "./qr-cli-DUoKpEh9.js";

//#region src/cli/clawbot-cli.ts
function registerClawbotCli(program) {
	registerQrCli(program.command("clawbot").description("Legacy clawbot command aliases").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/clawbot", "docs.PowPow.ai/cli/clawbot")}\n`));
}

//#endregion
export { registerClawbotCli };