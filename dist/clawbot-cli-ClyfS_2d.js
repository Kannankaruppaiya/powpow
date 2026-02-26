import "./paths-Qu8BKDZT.js";
import { B as theme } from "./utils-C9Yd70Dr.js";
import "./agent-scope-Coqt3COl.js";
import "./subsystem-A8uKC1In.js";
import "./exec-7lv95ExR.js";
import "./model-selection-DAT49TVG.js";
import "./github-copilot-token-oFsuQdhS.js";
import "./boolean-CE7i9tBR.js";
import "./env-BF71IqS7.js";
import "./host-env-security-IP2UsfGZ.js";
import "./config-ClR1jZcN.js";
import "./env-vars-C_dl05a-.js";
import "./manifest-registry-jY2uQzFh.js";
import "./ip-oUNIYnzv.js";
import { t as formatDocsLink } from "./links-DloDafB-.js";
import { n as registerQrCli } from "./qr-cli-BUNjyDwq.js";

//#region src/cli/clawbot-cli.ts
function registerClawbotCli(program) {
	registerQrCli(program.command("clawbot").description("Legacy clawbot command aliases").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/clawbot", "docs.PowPow.ai/cli/clawbot")}\n`));
}

//#endregion
export { registerClawbotCli };