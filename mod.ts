// deno-lint-ignore-file no-explicit-any

import { uuid } from "./deps.ts";
import { R } from "./deps.ts";

import {
	AnyFn,
	MessageFromWorker,
	MessageToWorker,
	PoolModule,
	PromisedModule,
	Promisify,
} from "./types.ts";

export type {
	AnyAsyncFn,
	AnyFn,
	Depromisify,
	MessageFromWorker,
	MessageToWorker,
	PoolModule,
	PromisedModule,
	Promisify,
} from "./types.ts";

const uid = () => uuid.v4();
export const expose = <Obj extends { [key: string]: AnyFn }>(obj: Obj) =>
	(w: any) => {
		w.onmessage = async <
			MethodName extends keyof Obj & string,
			InvokedFn extends Obj[MethodName],
			Payload extends Parameters<InvokedFn>,
		>(
			m: MessageToWorker<Payload, MethodName>,
		) => {
			if (m.data.method === "SHUTDOWN") {
				w.postMessage({
					payload: "closing now",
					id: m.data.id,
				});
				w.close();
			}
			const fn = obj[m.data.method];
			if (fn === undefined) {
				throw new Error(
					`Attempted to call ${m.data.method} which was not defined. Defined methods are ${
						JSON.stringify(
							Object.keys(obj),
						)
					}`,
				);
			}
			const result = await Promise.resolve(fn(...m.data.payload));

			try {
				w.postMessage({
					payload: result,
					id: m.data.id,
				});
			} catch (e) {
				console.log(e, result, m.data.id);
			}
		};
	};

const sendMsg = (worker: Worker) =>
	<A, B, V>(method: V, msg: A): Promise<B> => {
		const id = uid();

		const msgToWorker = {
			id: id,
			payload: msg,
			method: method,
		};
		const newP: Promise<B> = new Promise((resolve) => {
			const listenerFn = (m: MessageFromWorker<B>) => {
				if (m.data.id !== id) {
					return;
				} else {
					worker.removeEventListener("message", listenerFn);
					resolve(m.data.payload);
				}
			};
			worker.addEventListener("message", listenerFn);
		});
		try {
			worker.postMessage(msgToWorker);
		} catch (e) {
			console.log(e, msgToWorker);
		}
		return newP;
	};

export type PoolConfig<T> = {
	workerObj: T;
	modulePath: URL;
	numWorkers: number;
};

export class Pool<T extends PoolModule> {
	private workers: Worker[] = [];
	private obj: T;
	constructor(obj: T) {
		this.obj = obj;
	}

	static init<T extends PoolModule>(
		{ workerObj, modulePath, numWorkers }: PoolConfig<T>,
	) {
		const pool = new Pool(workerObj);
		pool.workers = R.range(0, numWorkers).map(
			() =>
				new Worker(modulePath.href, {
					type: "module",
					deno: true,
				} as WorkerOptions),
		);
		return pool;
	}

	static async fromModule<T extends PoolModule>(
		modulePath: URL,
		numWorkers: number,
	) {
		const mod = await import(modulePath.href);
		const workers = R.range(0, numWorkers).map(
			() =>
				new Worker(new URL("./worker.js", import.meta.url), {
					type: "module",
					deno: true,
				} as WorkerOptions),
		);
		const pool = new Pool(
			mod as { loadModuleFromPath: (a0: string) => void },
		);
		pool.workers = workers;
		await Promise.all(
			R.range(0, numWorkers).map(async (workerId) => {
				await pool.get("loadModuleFromPath", workerId)(modulePath.href);
			}),
		);
		return pool as unknown as Pool<T>;
	}

	add(modulePath: URL) {
		this.workers.push(
			new Worker(modulePath.href, {
				type: "module",
			}),
		);
		return this.createProxy(this.workers.length - 1);
	}

	get<
		MethodName extends keyof T,
		InvokedFn extends T[MethodName],
		Payload extends Parameters<InvokedFn>,
		ResultType extends ReturnType<InvokedFn>,
	>(
		method: MethodName,
		workerNo: number,
	): (...p: Payload) => Promisify<ResultType> {
		return (...p: Payload) =>
			sendMsg(this.workers[workerNo])(
				method,
				p,
			) as Promisify<ResultType>;
	}

	createProxy(workerNo: number): PromisedModule<T> {
		const keys: (keyof T)[] = Object.keys(this.obj);
		const proxy = new Object() as PromisedModule<T>;
		keys.forEach((k) => (proxy[k] = this.get(k, workerNo)));
		return proxy;
	}

	async shutdown() {
		await Promise.all(
			this.workers.map(async (w) => await sendMsg(w)("SHUTDOWN", null)),
		);
	}
}