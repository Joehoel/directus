import type {
	ActionHandler,
	ApiExtension,
	BundleExtension,
	DatabaseExtension,
	EmbedHandler,
	EndpointConfig,
	FilterHandler,
	HookConfig,
	HybridExtension,
	InitHandler,
	OperationApiConfig,
	ScheduleHandler,
} from '@directus/types';
import getModuleDefault from '../utils/get-module-default.js';
import type { ExtensionManager } from './extensions.js';
import path from 'path';
import logger from '../logger.js';
import { generateExtensionsEntrypoint, pathToRelativeUrl, resolvePackage } from '@directus/utils/node';
import emitter from '../emitter.js';
import { getFlowManager } from '../flows.js';
import type { EventHandler } from '../types/events.js';
import { getSchema } from '../utils/get-schema.js';
import getDatabase from '../database/index.js';
import env from '../env.js';
import * as services from '../services/index.js';
import express, { Router } from 'express';
import { APP_SHARED_DEPS } from '@directus/constants';
import { rollup } from 'rollup';

import { escapeRegExp } from 'lodash-es';
import { Url } from '../utils/url.js';

import aliasDefault from '@rollup/plugin-alias';
import nodeResolveDefault from '@rollup/plugin-node-resolve';
import virtualDefault from '@rollup/plugin-virtual';

import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scheduleSynchronizedJob, validateCron } from '../utils/schedule.js';

const virtual = virtualDefault as unknown as typeof virtualDefault.default;
const alias = aliasDefault as unknown as typeof aliasDefault.default;
const nodeResolve = nodeResolveDefault as unknown as typeof nodeResolveDefault.default;

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

type BundleConfig = {
	endpoints: { name: string; config: EndpointConfig }[];
	hooks: { name: string; config: HookConfig }[];
	operations: { name: string; config: OperationApiConfig }[];
};

type ApiExtensions = { path: string }[];

export class RegistrationManager {
	private extensionManager: ExtensionManager;
	private apiExtensions: ApiExtensions = [];
	private hookEvents: EventHandler[] = [];
	public endpointRouter: Router;
	private appExtensionChunks: Map<string, string>;

	constructor(extensionManager: ExtensionManager) {
		this.extensionManager = extensionManager;
		this.endpointRouter = Router();
		this.appExtensionChunks = new Map();
	}

	public async registerHooks(): Promise<void> {
		const hooks = this.extensionManager
			.getEnabledExtensions()
			.filter((extension) => extension.type === 'hook') as (ApiExtension & DatabaseExtension)[];

		for (const hook of hooks) {
			if (hook.secure) {
				const hookPath = path.resolve(hook.path, hook.entrypoint);

				this.extensionManager.vm.runExtension(hook, hookPath);

				return
			}

			try {
				const hookPath = path.resolve(hook.path, hook.entrypoint);

				const hookInstance: HookConfig | { default: HookConfig } = await import(
					`./${pathToRelativeUrl(hookPath, __dirname)}?t=${Date.now()}`
				);

				const config = getModuleDefault(hookInstance);

				this.registerHook(config, hook.name);

				this.apiExtensions.push({ path: hookPath });
			} catch (error: any) {
				logger.warn(`Couldn't register hook "${hook.name}"`);
				logger.warn(error);
			}
		}
	}

	public async registerEndpoints(): Promise<void> {
		const endpoints = this.extensionManager
			.getEnabledExtensions()
			.filter((extension) => extension.type === 'endpoint') as (ApiExtension & DatabaseExtension)[];

		for (const endpoint of endpoints) {
			const endpointPath = path.resolve(endpoint.path, endpoint.entrypoint);

			if (endpoint.secure) {
				this.extensionManager.vm.runExtension(endpoint, endpointPath)
				return
			}

			try {
				const endpointInstance: EndpointConfig | { default: EndpointConfig } = await import(
					`./${pathToRelativeUrl(endpointPath, __dirname)}?t=${Date.now()}`
				);

				const config = getModuleDefault(endpointInstance);

				this.registerEndpoint(config, endpoint.name);

				this.apiExtensions.push({ path: endpointPath });
			} catch (error: any) {
				logger.warn(`Couldn't register endpoint "${endpoint.name}"`);
				logger.warn(error);
			}
		}
	}

	public async registerOperations(): Promise<void> {
		const internalOperations = await readdir(path.join(__dirname, '../', 'operations'));

		for (const operation of internalOperations) {
			const operationInstance: OperationApiConfig | { default: OperationApiConfig } = await import(
				`../operations/${operation}/index.js`
			);

			const config = getModuleDefault(operationInstance);

			this.registerOperation(config);
		}

		const operations = this.extensionManager
			.getEnabledExtensions()
			.filter((extension) => extension.type === 'operation') as (HybridExtension & DatabaseExtension)[];

		for (const operation of operations) {

			if (operation.secure) {
				const operationPath = path.resolve(operation.path, operation.entrypoint.api!);

				this.extensionManager.vm.runExtension(operation, operationPath)

				return
			}

			try {
				const operationPath = path.resolve(operation.path, operation.entrypoint.api!);

				const operationInstance: OperationApiConfig | { default: OperationApiConfig } = await import(
					`./${pathToRelativeUrl(operationPath, __dirname)}?t=${Date.now()}`
				);

				const config = getModuleDefault(operationInstance);

				this.registerOperation(config);

				this.apiExtensions.push({ path: operationPath });
			} catch (error: any) {
				logger.warn(`Couldn't register operation "${operation.name}"`);
				logger.warn(error);
			}
		}
	}

	public async registerBundles(): Promise<void> {
		const bundles = this.extensionManager
			.getEnabledExtensions()
			.filter((extension) => extension.type === 'bundle') as (BundleExtension & DatabaseExtension)[];

		for (const bundle of bundles) {

			if (bundle.secure) {
				const bundlePath = path.resolve(bundle.path, bundle.entrypoint.api);

				this.extensionManager.vm.runExtension(bundle, bundlePath)

				return
			}

			try {
				const bundlePath = path.resolve(bundle.path, bundle.entrypoint.api);

				const bundleInstances: BundleConfig | { default: BundleConfig } = await import(
					`./${pathToRelativeUrl(bundlePath, __dirname)}?t=${Date.now()}`
				);

				const configs = getModuleDefault(bundleInstances);

				for (const { config, name } of configs.hooks) {
					this.registerHook(config, name);
				}

				for (const { config, name } of configs.endpoints) {
					this.registerEndpoint(config, name);
				}

				for (const { config } of configs.operations) {
					this.registerOperation(config);
				}

				this.apiExtensions.push({ path: bundlePath });
			} catch (error: any) {
				logger.warn(`Couldn't register bundle "${bundle.name}"`);
				logger.warn(error);
			}
		}
	}

	public registerHook(register: HookConfig, name: string): void {
		let scheduleIndex = 0;

		const registerFunctions = {
			filter: (event: string, handler: FilterHandler) => {

				emitter.onFilter(event, handler);

				this.hookEvents.push({
					type: 'filter',
					name: event,
					handler,
				});
			},
			action: (event: string, handler: ActionHandler) => {
				emitter.onAction(event, handler);

				this.hookEvents.push({
					type: 'action',
					name: event,
					handler,
				});
			},
			init: (event: string, handler: InitHandler) => {
				emitter.onInit(event, handler);

				this.hookEvents.push({
					type: 'init',
					name: event,
					handler,
				});
			},
			schedule: (cron: string, handler: ScheduleHandler) => {
				if (validateCron(cron)) {
					const job = scheduleSynchronizedJob(`${name}:${scheduleIndex}`, cron, async () => {
						if (this.extensionManager.options.schedule) {
							try {
								await handler();
							} catch (error: any) {
								logger.error(error);
							}
						}
					});

					scheduleIndex++;

					this.hookEvents.push({
						type: 'schedule',
						job,
					});
				} else {
					logger.warn(`Couldn't register cron hook. Provided cron is invalid: ${cron}`);
				}
			},
			embed: (position: 'head' | 'body', code: string | EmbedHandler) => {
				const content = typeof code === 'function' ? code() : code;

				if (content.trim().length === 0) {
					logger.warn(`Couldn't register embed hook. Provided code is empty!`);
					return;
				}

				if (position === 'head') {
					this.extensionManager.hookEmbedsHead.push(content);
				}

				if (position === 'body') {
					this.extensionManager.hookEmbedsBody.push(content);
				}
			},
		};

		register(registerFunctions, {
			services,
			env,
			database: getDatabase(),
			emitter: this.extensionManager.apiEmitter,
			logger,
			getSchema,
		});
	}

	private registerEndpoint(config: EndpointConfig, name: string): void {
		const register = typeof config === 'function' ? config : config.handler;
		const routeName = typeof config === 'function' ? name : config.id;

		const scopedRouter = express.Router();
		this.endpointRouter.use(`/${routeName}`, scopedRouter);

		register(scopedRouter, {
			services,
			env,
			database: getDatabase(),
			emitter: this.extensionManager.apiEmitter,
			logger,
			getSchema,
		});
	}

	private registerOperation(config: OperationApiConfig): void {
		const flowManager = getFlowManager();

		flowManager.addOperation(config.id, config.handler);
	}

	public async unregisterApiExtensions(): Promise<void> {
		for (const event of this.hookEvents) {
			switch (event.type) {
				case 'filter':
					emitter.offFilter(event.name, event.handler);
					break;
				case 'action':
					emitter.offAction(event.name, event.handler);
					break;
				case 'init':
					emitter.offInit(event.name, event.handler);
					break;
				case 'schedule':
					await event.job.stop();
					break;
			}
		}

		this.hookEvents = [];

		this.endpointRouter.stack = [];

		const flowManager = getFlowManager();

		flowManager.clearOperations();

		for (const apiExtension of this.apiExtensions) {
			delete require.cache[require.resolve(apiExtension.path)];
		}

		this.apiExtensions = [];
	}

	public getAppExtensionChunk(name: string): string | null {
		return this.appExtensionChunks.get(name) ?? null;
	}

	public async generateExtensionBundle(): Promise<string | null> {
		const sharedDepsMapping = await this.getSharedDepsMapping(APP_SHARED_DEPS);

		const internalImports = Object.entries(sharedDepsMapping).map(([name, path]) => ({
			find: name,
			replacement: path,
		}));

		const entrypoint = generateExtensionsEntrypoint(this.extensionManager.getEnabledExtensions());

		try {
			const bundle = await rollup({
				input: 'entry',
				external: Object.values(sharedDepsMapping),
				makeAbsoluteExternalsRelative: false,
				plugins: [virtual({ entry: entrypoint }), alias({ entries: internalImports }), nodeResolve({ browser: true })],
			});

			const { output } = await bundle.generate({ format: 'es', compact: true });

			for (const out of output) {
				if (out.type === 'chunk') {
					this.appExtensionChunks.set(out.fileName, out.code);
				}
			}

			await bundle.close();

			return output[0].code;
		} catch (error: any) {
			logger.warn(`Couldn't bundle App extensions`);
			logger.warn(error);
		}

		return null;
	}

	private async getSharedDepsMapping(deps: string[]): Promise<Record<string, string>> {
		const appDir = await readdir(path.join(resolvePackage('@directus/app', __dirname), 'dist', 'assets'));

		const depsMapping: Record<string, string> = {};

		for (const dep of deps) {
			const depRegex = new RegExp(`${escapeRegExp(dep.replace(/\//g, '_'))}\\.[0-9a-f]{8}\\.entry\\.js`);
			const depName = appDir.find((file) => depRegex.test(file));

			if (depName) {
				const depUrl = new Url(env['PUBLIC_URL']).addPath('admin', 'assets', depName);

				depsMapping[dep] = depUrl.toString({ rootRelative: true });
			} else {
				logger.warn(`Couldn't find shared extension dependency "${dep}"`);
			}
		}

		return depsMapping;
	}
}
