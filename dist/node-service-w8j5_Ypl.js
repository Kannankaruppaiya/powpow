import { _ as resolveNodeWindowsTaskName, a as NODE_SERVICE_KIND, g as resolveNodeSystemdServiceName, h as resolveNodeLaunchAgentLabel, o as NODE_SERVICE_MARKER, s as NODE_WINDOWS_TASK_SCRIPT_NAME } from "./constants-Clw8zvXe.js";
import { t as resolveGatewayService } from "./service-DkDZ7shP.js";

//#region src/daemon/node-service.ts
function withNodeServiceEnv(env) {
	return {
		...env,
		POWPOW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
		POWPOW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
		POWPOW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
		POWPOW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
		POWPOW_LOG_PREFIX: "node",
		POWPOW_SERVICE_MARKER: NODE_SERVICE_MARKER,
		POWPOW_SERVICE_KIND: NODE_SERVICE_KIND
	};
}
function withNodeInstallEnv(args) {
	return {
		...args,
		env: withNodeServiceEnv(args.env),
		environment: {
			...args.environment,
			POWPOW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
			POWPOW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
			POWPOW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
			POWPOW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
			POWPOW_LOG_PREFIX: "node",
			POWPOW_SERVICE_MARKER: NODE_SERVICE_MARKER,
			POWPOW_SERVICE_KIND: NODE_SERVICE_KIND
		}
	};
}
function resolveNodeService() {
	const base = resolveGatewayService();
	return {
		...base,
		install: async (args) => {
			return base.install(withNodeInstallEnv(args));
		},
		uninstall: async (args) => {
			return base.uninstall({
				...args,
				env: withNodeServiceEnv(args.env)
			});
		},
		stop: async (args) => {
			return base.stop({
				...args,
				env: withNodeServiceEnv(args.env ?? {})
			});
		},
		restart: async (args) => {
			return base.restart({
				...args,
				env: withNodeServiceEnv(args.env ?? {})
			});
		},
		isLoaded: async (args) => {
			return base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}) });
		},
		readCommand: (env) => base.readCommand(withNodeServiceEnv(env)),
		readRuntime: (env) => base.readRuntime(withNodeServiceEnv(env))
	};
}

//#endregion
export { resolveNodeService as t };