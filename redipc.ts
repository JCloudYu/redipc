import Events = require('events');
import Beson	= require('beson');
import REDIS	= require('redis');
import TrimId	= require('trimid');



type AnyObject = {[key:string]:any};
type AnyFunction = (...args:any[])=>void;
interface FlattendPromise<T> {
	promise:Promise<T>;
	resolve:AnyFunction;
	reject:AnyFunction;
};
interface CallbackTask<ReturnType=any> extends FlattendPromise<ReturnType> {
	id:string;
	time:number;
	timeout:null|NodeJS.Timeout;
};
type REDIPCInitOptions = {
	redis: {
		uri:string,
		[key:string]:any
	},
	channels?: string[];
	timeout?:number;
	silent?: boolean;
};
type REDIPCPrivates = {
	silent:boolean;
	response_box_id:string;
	client:REDIS.RedisClient|null;
	pubsub:REDIS.RedisClient|null;
	task_map:Map<string, CallbackTask>;
	call_map:Map<string, AnyFunction>;
	channels:string[];
	timeout:{(callback:(...args:any[])=>any, delay:number, ...args:any[]):void; clear:()=>any},
	timeout_dur:number;
};
type REDISErrorDescriptor = {
	code?:string;
	message?:string;
	stack_trace?:string[];
} & AnyObject;
type HandlerMap = {[func:string]:AnyFunction};
type REDIPCEvent = {
	id:string;
	src:string;
	evt:string;
	args:any[];
	timestamp: number;
};






export class REDISError extends Error {
	[key:string]:any;
	
	readonly code:string;
	readonly stack_trace:string[];
	constructor(err_desc:REDISErrorDescriptor) {
		if ( Object(err_desc) !== err_desc ) {
			throw new Error("REDISError constructor accept only errors or error descriptors!");
		}

		let {code, message, ...additional} = err_desc;
		if ( typeof message !== "string" ) {
			message = "Unkown error";
		}

		if ( typeof code !== "string" ) {
			code = 'unkown-error';
		}
		
		super(message);



		this.code = code;
		this.stack_trace = Array.isArray(err_desc.stack_trace) ? err_desc.stack_trace : (this.stack ? this.stack.split(/\n|\r\n/).map(l=>l.trim()) : []);
		Object.assign(this, additional);
	}
};

export class REDISTimeoutError extends REDISError {
	readonly id:string;
	readonly channel:string;
	readonly func:string;
	readonly timestamp:number;
	constructor(msg_id:string, channel:string, func:string, timestamp:number) {
		super({
			code:'timeout-error',
			message: `Request timeout when invoking \`${channel}\`::\`${func}\``
		});

		this.id = msg_id;
		this.channel = channel;
		this.func = func;
		this.timestamp = timestamp;
	}
};



const BATCH_COUNT = 25;
const DEFAULT_TIMEOUT_DURATION = 30 * 1000;
const NULL_BESON = Beson.Serialize(null);
const __REDIPC = new WeakMap<REDIPC, REDIPCPrivates>();
export default class REDIPC extends Events.EventEmitter {
	constructor(init_inst_id?:string) {
		super();

		let inst_id:TrimId;
		if ( arguments.length > 0 ) {
			let buff = TrimId.fromBase32Hex(init_inst_id!);
			if ( buff === null ) {
				throw new TypeError("Given init id is invalid!");
			}
			inst_id = buff;
		}
		else {
			inst_id = TrimId.NEW;
		}

		__REDIPC.set(this, {
			silent:false,
			response_box_id: `_redipc.${inst_id.toString(32)}`,
			client:null,
			pubsub:null,
			task_map:new Map(),
			call_map:new Map(),
			channels:[],
			timeout: ThrottledTimeout(),
			timeout_dur: DEFAULT_TIMEOUT_DURATION
		});
	}
	get id():string {
		return __REDIPC.get(this)!.response_box_id;
	}
	get connected() {
		const {client} = __REDIPC.get(this)!;
		return client === null ? false : client.connected;
	}
	set timeout(second:number) {
		const _REDIPC = __REDIPC.get(this)!;
		_REDIPC.timeout_dur = (second <= 0 ? 0 : second) * 1000;
	}
	get timeout():number {
		return __REDIPC.get(this)!.timeout_dur;
	}
	async close() {
		const {client, pubsub, timeout} = __REDIPC.get(this)!;
		
		const promises:any[] = [];
		if ( client !== null && client.connected ) {
			promises.push(client.quit());
		}
		
		if ( pubsub !== null && pubsub.connected ) {
			promises.push(pubsub.quit());
		}

		timeout.clear();

		return Promise.all(promises);
	}
	register(map:HandlerMap):REDIPC;
	register(func:string, handler:AnyFunction):REDIPC;
	register(func:string|HandlerMap, handler?:AnyFunction):REDIPC {
		const {call_map} = __REDIPC.get(this)!;

		if ( typeof func !== "string" ) {
			if ( Object(func) === func ) {
				for(const key in func) {
					const callable = func[key];
					if ( typeof callable !== "function" ) continue;
					
					call_map.set(key, func[key]);
				}
			}
		}
		else 
		if ( typeof handler === "function" ) {
			call_map.set(''+func, handler);
		}

		return this;
	}
	async remoteCall<ReturnType=any>(channel:string, func:string, ...args:any[]):Promise<ReturnType> {
		const {response_box_id, client, task_map, timeout_dur} = __REDIPC.get(this)!;
		if ( !client ) throw new Error("REDIPC instance is not initialized yet!");


		const id = TrimId.NEW.toString(32);
		const timestamp = Date.now();

		const call_job:CallbackTask<ReturnType> = Object.assign({id, time:timestamp, timeout:null}, GenPromise<ReturnType>());
		task_map.set(id, call_job);

		await REDISRPush(client, channel, Beson.Serialize({
			id, src:response_box_id,
			func, args, timestamp
		}));
		await REDISPublish(client, channel, id);


		call_job.timeout = setTimeout(()=>{
			task_map.delete(id);
			call_job.reject(new REDISTimeoutError(id, channel, func, timestamp));
		}, timeout_dur);



		return call_job.promise;
	}
	async remoteEvent(channel:string, event:string, ...args:any[]):Promise<void> {
		const {response_box_id, client, task_map} = __REDIPC.get(this)!;
		if ( !client ) throw new Error("REDIPC instance is not initialized yet!");
		
		const event_info:REDIPCEvent =  {
			id:TrimId.NEW.toString(32), src:response_box_id,
			evt:event, args, timestamp:Date.now()
		};
		await REDISPublish(client, channel, Beson.Serialize(event_info));
	}
	static async init(options:REDIPCInitOptions) {
		if ( Object(options) !== options ) {
			throw new TypeError("Given connection options must be a key-value object!");
		}
		
		return Promise.resolve().then(async()=>{
			const inst = new REDIPC();
			const {redis, channels:_channels, silent} = options;
			const channels = Array.isArray(_channels) ? _channels.slice(0) : [];
			channels.unshift(inst.id);

			
			
			const _REDIPC = __REDIPC.get(inst)!;
			_REDIPC.silent = !!silent;
			_REDIPC.channels = channels;

			if ( typeof options.timeout === "number" ) {
				inst.timeout = options.timeout!;
			}

			const {uri:redis_uri, detect_buffers:_} = redis;
			const {timeout, response_box_id} = _REDIPC;
			const client = _REDIPC.client = REDIS.createClient({
				url:redis_uri, detect_buffers:true
			});
			const sub_client = _REDIPC.pubsub = _REDIPC.client.duplicate();

			sub_client.on('message_buffer', (_:Buffer, data:Buffer)=>{
				const channel_data = Beson.Deserialize(data);
				timeout(async()=>{
					if ( channel_data !== undefined && channel_data !== null ) {
						HandleEvent.call(inst, channel_data);
					}
					
					await HandleMessage.call(inst);
				}, 0);
			});
			await REDISSubscribe(sub_client, channels);


			// Force REDIPC client it self to start consuming existing invokation data
			setTimeout(()=>REDISPublish(client, response_box_id, NULL_BESON), 100);
			

			return inst;
		});
	}
};


function HandleMessage(this:REDIPC) {
	const {client, response_box_id, timeout, channels} = __REDIPC.get(this)!;

	return Promise.resolve().then(async()=>{
		for(let i=0; i<BATCH_COUNT; i++) {
			let proc_data_count = 0;
			
			for(const channel of channels) {
				const data = await REDISLPop(client!, Buffer.from(channel));
				if ( !data ) continue;
				proc_data_count++;


				const result = Beson.Deserialize(data);
				if ( result === null || result === undefined || Object(result) !== result ) continue;




				const {id, func, args, err, res} = result;
				if ( typeof id !== "string" ) continue;
				

				if ( func !== undefined || args !== undefined ) {
					await HandleRequest.call(this, result);
				}
				else
				if ( response_box_id === channel ) {
					await HandleResponse.call(this, result);
				}
				else {
					continue;
				}
			}

			if ( proc_data_count === 0 ) return;
		}
		
		timeout(HandleMessage.bind(this), 0);
	}).catch((e)=>console.error(e));
}
async function HandleRequest(this:REDIPC, result:{id:string, src:string, func:string, args:any[], timestamp:number}):Promise<void> {
	const {call_map, client, silent, timeout_dur} = __REDIPC.get(this)!;



	const {id, src, func, args, timestamp} = result;
	if ( typeof id !== "string" || typeof src !== "string" || typeof func !== "string" || !Array.isArray(args) || typeof timestamp !== "number" ) return;
	if ( (Date.now() - timestamp) > timeout_dur ) return;
	
	
	const handler = call_map.get(func);
	if ( !handler ) {
		await REDISRPush(client!, src, Beson.Serialize({
			id, err: { 
				code:'error#func-undefined', 
				message:`Requested function '${func}' is not defined`, 
				func
			}
		}));
		await REDISPublish(client!, src, id);
		return;
	}

	
	return Promise.resolve()
	.then(()=>handler(...args))
	.then(async(result)=>{
		await REDISRPush(client!, src, Beson.Serialize({id, res:result}));
		await REDISPublish(client!, src, id);
	})
	.catch(async(e)=>{
		if ( !silent ) console.error(e);

		const error:AnyObject = {};
		if ( e instanceof Error ) {
			// @ts-ignore
			error.code = e.code||'exec-error';
			error.message = e.message;
			error.stack_trace = !e.stack ? [] : e.stack.split(/\n|\r\n/).map(l=>l.trim());
			Object.assign(error, e);
		}
		else if ( Object(e) === e ) {
			error.code = e.code||'exec-error';
			error.message = e.message||'Unexpected execution error!';
			Object.assign(error, e);
		}
		else {
			error.code = 'exec-error';
			error.message = 'Unexpected execution error!';
			error._detail = e;
		}


		await REDISRPush(client!, src, Beson.Serialize({id, err:error}));
		await REDISPublish(client!, src, id);
	});
}
function HandleResponse(this:REDIPC, result:{id:string, err:REDISErrorDescriptor, res:any}):void {
	const {task_map} = __REDIPC.get(this)!;
	const {id, err, res} = result;

	const task = task_map.get(id);
	if ( !task ) return;
	task_map.delete(id);



	if ( task.timeout ) {
		clearTimeout(task.timeout);
		task.timeout = null;
	}

	const {resolve, reject} = task;
	err ? reject(new REDISError(err)) : resolve(res);
}
function HandleEvent(this:REDIPC, evt_data:REDIPCEvent) {
	const {id, src, evt, args} = evt_data;
	if ( typeof id !== "string" || typeof src !== "string" || typeof evt !== "string" || !Array.isArray(args)) return;

	this.emit(evt, {event:evt, id, src}, ...args);
}





function GenPromise<T>():FlattendPromise<T> {
	const p = {} as FlattendPromise<T>;
	p.promise = new Promise<T>((res, rej)=>{
		p.resolve=res;
		p.reject=rej
	});
	return p;
}
function ThrottledTimeout():{(callback:(...args:any[])=>any, delay:number, ...args:any[]):void; clear:()=>any} {
	let hTimeout:number|NodeJS.Timeout|null=null,
		nextTask:{cb:()=>any, delay:number, args:any[]}|null=null, 
		running=false;

	const timeout = function(cb:(...args:any[])=>any, delay:number=0, ...args:any[]) {
		if ( hTimeout ) {
			if ( running ) {
				nextTask = {cb, delay, args};
				return;
			}
			else {
				clearTimeout(hTimeout as number);
			}
		}

		hTimeout = setTimeout(()=>{
			running = true;

			Promise.resolve()
			.then(()=>cb())
			.finally(()=>{
				running = false;
				hTimeout = !nextTask ? null : setTimeout(nextTask.cb, nextTask.delay, ...nextTask.args);
				nextTask = null;
			});
		}, delay, ...args);
	};
	
	timeout.clear = function() {
		clearTimeout(hTimeout as number);
		nextTask = null;
		running = false;
	};
	
	return timeout;
}
async function REDISSubscribe(client:REDIS.RedisClient, channel:string|string[]):Promise<string> {
	return new Promise((resolve, reject)=>{
		client.subscribe(channel, (err, result)=>{
			err ? reject(err) : resolve(result);
		});
	});
}
async function REDISPublish(client:REDIS.RedisClient, channel:string, value:string|Buffer|Uint8Array) {
	return new Promise((resolve, reject)=>{
		if ( value instanceof Uint8Array ) {
			value = Buffer.from(value);
		}

		// @ts-ignore
		client.publish(channel, value, (err, result)=>{
			err ? reject(err) : resolve(result);
		});
	});
}
async function REDISRPush(client:REDIS.RedisClient, slot_id:string, ...data:(string|Buffer|Uint8Array|ArrayBuffer)[]):Promise<number>{
	return new Promise((resolve, reject)=>{
		const set_data:any[] = [];
		for(const raw_data of data) {
			if ( raw_data instanceof Uint8Array ) {
				set_data.push(Buffer.from(raw_data));
			}
			else if ( raw_data instanceof ArrayBuffer ) {
				set_data.push(Buffer.from(raw_data));
			}
			else {
				set_data.push(raw_data);
			}
		}

		// @ts-ignore
		client.rpush(slot_id, ...set_data, (err, result)=>{
			err ? reject(err) : resolve(result);
		});
	});
}

async function REDISLPop(client:REDIS.RedisClient, slot_id:string):Promise<string>;
async function REDISLPop(client:REDIS.RedisClient, slot_id:Buffer):Promise<Buffer>;
async function REDISLPop(client:REDIS.RedisClient, slot_id:string|Buffer):Promise<string|Buffer> {
	return new Promise((resolve, reject)=>{
		// @ts-ignore
		client.lpop(slot_id, (err, result)=>{
			err ? reject(err) : resolve(result);
		});
	});
}