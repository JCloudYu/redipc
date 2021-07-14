(()=>{
	"use strict";

	const EEmitter	= require('events');
	const Beson		= require('beson');
	const REDIS		= require('redis');
	const TrimId	= require('trimid');



	const __REDIPC = new WeakMap();
	class REDIPC extends EEmitter {
		constructor() {
			super();

			const inst_id = TrimId.NEW.toString(64);
			__REDIPC.set(this, Object.assign(Object.create(null), {
				inst_id, client:null,
				invoke_list:new Map()
			}));
		}
		get connected() {
			const client = __REDIPC.get(this);
			return client === null ? false : client.connected;
		}
		get state() {
			const client = __REDIPC.get(this);
			if ( client === null ) return null;
			
			return {
				connected: client.connected,
				queue: {
					online: client.command_queue_length,
					offline: client.offline_queue_length,
				},
				server_version: client.redis_version
			};
		}
		async call(scope, func, ...args) {
			const {inst_id, client} = __REDIPC.get(this);

			// NOTE: Scope doesn't accept periods
			scope = scope.replace('.', '_');
			return new Promise((resolve, reject)=>{
				const id = TrimId.NEW.toString();
				const timestamp = Date.now();
				const call_scope = `_ipc.${scope}.call`;
				client.rpush(call_scope, Beson.Serialize({
					id, timestamp, src:inst_id,
					func, args,
				}));
				client.publish(call_scope, id);
				invoke_list.set(call_id, {resolve, reject, timestamp});
			});
		}
		static async connect(options) {
			if ( Object(options) !== options ) {
				throw new TypeError("Given connection options must be a key-value object!");
			}
			
			return Promise.resolve().then(async()=>{
				const inst = new REDIPC();
				const {redis, scope=null} = options;
				const scope_id = scope ? `_ipc.${scope}.call` : '';
				
				const _REDIPC = __REDIPC.get(inst);
				const inst_id = _REDIPC;
				const client = _REDIPC.client = REDIS.createClient(redis);

				const promises = {};
				client.on('subscribe', (channel, count)=>{
					promises[channel].resolve(count);
				});

				{
					promises[`_ipc.${inst_id}.res`] = GenPromise();
					client.subscribe(`_ipc.${inst_id}.res`);
				}

				if ( scope_id ) {
					promises[scope_id] = GenPromise();
					client.subscribe(scope_id);
				}
				

				await Promise.all(Object.values(promises));
				

				// Register handlers
				client.on('message_buffer', HandlePubMsg.bind(this));

				if ( scope_id ) {
					// Force instance to handle scope calls
					setTimeout(()=>client.publish(scope_id, ''), 0);
				}

				
				return inst;
			});
		}
	}
	

	function GenPromise() {
		let res = null, rej = null;
		const p = new Promise((resolve, reject)=>{res=resolve;rej=reject});
		p.resolve = res; p.reject = rej;
		return p;
	}
	function HandlePubMsg(channel, msg) {
		const {client, invoke_list, inst_id} = __REDIPC.get(this);
	}

	module.exports = REDIPC;
})();