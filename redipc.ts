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
interface CallbackTask extends FlattendPromise<any> {
	id:string;
	time:number;
};
type REDIPCInitOptions = {
	redis: {uri:string},
	channels?: string[]
};
type REDIPCPrivates = {
	response_box_id:string,
	client:REDIS.RedisClient|null,
	pubsub:REDIS.RedisClient|null,
	task_map:Map<string, CallbackTask>,
	call_map:Map<string, AnyFunction>,
	timeout:{(callback:(...args:any[])=>any, delay:number, ...args:any[]):void; clear:()=>any}
};
type REDISErrorDescriptor = {
	code?:string;
	message?:string;
} & AnyObject & Error;
type HandlerMap = {[func:string]:AnyFunction};






export class REDISError extends Error {
	[key:string]:any;
	
	readonly code:string;
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
		Object.assign(this, additional);
	}
};



const BATCH_COUNT = 25;
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
			response_box_id: `_redipc.${inst_id.toString(32)}`,
			client:null,
			pubsub:null,
			task_map:new Map(),
			call_map:new Map(),
			timeout: ThrottledTimeout()
		});
	}
	get id():string {
		return __REDIPC.get(this)!.response_box_id;
	}
	get connected() {
		const {client} = __REDIPC.get(this)!;
		return client === null ? false : client.connected;
	}
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
	async remoteCall(channel:string, func:string, ...args:any[]):Promise<any> {
		const {response_box_id, client, task_map} = __REDIPC.get(this)!;
		if ( !client ) throw new Error("REDIPC instance is not initialized yet!");


		const id = TrimId.NEW.toString(32);
		const timestamp = Date.now();

		const call_job:CallbackTask = Object.assign({id, time:timestamp}, GenPromise<any>());
		task_map.set(id, call_job);

		await REDISRPush(client, channel, Beson.Serialize({
			id, src:response_box_id,
			func, args, timestamp
		}));
		await REDISPublish(client, channel, id);



		return call_job.promise;
	}
	static async init(options:REDIPCInitOptions) {
		if ( Object(options) !== options ) {
			throw new TypeError("Given connection options must be a key-value object!");
		}
		
		return Promise.resolve().then(async()=>{
			const inst = new REDIPC();
			const {redis, channels:_channels} = options;
			const channels = Array.isArray(_channels) ? _channels.slice(0) : [];
			channels.push(inst.id);

			
			
			const _REDIPC = __REDIPC.get(inst)!;
			const {response_box_id, timeout} = _REDIPC;
			_REDIPC.client = REDIS.createClient({
				url:redis.uri, detect_buffers:true
			});
			const client = _REDIPC.pubsub = _REDIPC.client.duplicate();

			client.on('message_buffer', (channel:string|Buffer, data:Buffer)=>{
				channel = channel.toString('utf8');
				if ( channel === response_box_id ) {
					timeout(HandleResponse.bind(inst), 0);
				}
				else {
					timeout(HandleRequest.bind(inst, channel), 0);
				}
			});

			await REDISSubscribe(client, channels);
			

			return inst;
		});
	}
};

function HandleRequest(this:REDIPC, channel:string):Promise<void> {
	const {call_map, client, timeout} = __REDIPC.get(this)!;

	return Promise.resolve().then(async()=>{
		for(let i=0; i<BATCH_COUNT; i++) {
			const data = await REDISLPop(client!, Buffer.from(channel));
			if ( !data ) return;


			const result = Beson.Deserialize(data);
			if ( result === null || result === undefined || Object(result) !== result ) continue;

			const {id, src, func, args} = result;
			if ( typeof id !== "string" || typeof src !== "string" || typeof func !== "string" || !Array.isArray(args) ) continue;
			
			
			
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
				continue; 
			}

			
			Promise.resolve()
			.then(()=>handler(...args))
			.then(async(result)=>{
				await REDISRPush(client!, src, Beson.Serialize({id, res:result}));
				await REDISPublish(client!, src, id);
			})
			.catch(async(e)=>{
				const error:AnyObject = {};
				if ( e instanceof Error ) {
					// @ts-ignore
					error.code = e.code||'exec-error';
					error.message = e.message;
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



		timeout(HandleRequest.bind(this, channel), 0);
	}).catch((e)=>console.error(e));
}
function HandleResponse(this:REDIPC):Promise<void> {
	const {task_map, client, response_box_id, timeout} = __REDIPC.get(this)!;

	return Promise.resolve().then(async()=>{
		for(let i=0; i<BATCH_COUNT; i++) {
			const data = await REDISLPop(client!, Buffer.from(response_box_id));
			if ( !data ) return;

			const result = Beson.Deserialize(data);
			if ( result === null || result === undefined || Object(result) !== result ) continue;

			const {id, err, res} = result;

			const task = task_map.get(id);
			if ( !task ) continue;


			const {resolve, reject} = task;
			if ( err !== undefined ) {
				reject(new REDISError(err));
				continue;
			}

			resolve(res);
		}


		
		timeout(HandleResponse.bind(this), 0);
	});
}






function GenPromise<T>():FlattendPromise<T> {
	const p = {} as FlattendPromise<T>;
	p.promise = new Promise((res, rej)=>{
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