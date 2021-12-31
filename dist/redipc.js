"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REDISTimeoutError = exports.REDIPCError = void 0;
const Events = require("events");
const Beson = require("beson");
const REDIS = require("redis");
const TrimId = require("trimid");
;
;
class REDIPCError extends Error {
    constructor(err_desc) {
        if (Object(err_desc) !== err_desc) {
            throw new Error("REDISError constructor accept only errors or error descriptors!");
        }
        let { code, message, callstack, detail } = err_desc;
        if (typeof message !== "string") {
            message = "Unkown error";
        }
        super(message);
        this.code = typeof code === 'string' ? code : 'redipc#unkown-error';
        this.callstack = callstack || this.stack || '';
        this.detail = detail;
    }
}
exports.REDIPCError = REDIPCError;
;
class REDISTimeoutError extends REDIPCError {
    constructor(msg_id, channel, func, timestamp) {
        super({
            code: 'timeout-error',
            message: `Request timeout when invoking \`${channel}\`::\`${func}\``,
            callstack: '',
            detail: ''
        });
        this.id = msg_id;
        this.channel = channel;
        this.func = func;
        this.timestamp = timestamp;
    }
}
exports.REDISTimeoutError = REDISTimeoutError;
;
const BATCH_COUNT = 25;
const DEFAULT_TIMEOUT_DURATION = 30 * 1000;
const NULL_BESON = Beson.Serialize(null);
const __REDIPC = new WeakMap();
class REDIPC extends Events.EventEmitter {
    constructor(init_inst_id) {
        super();
        let inst_id;
        if (arguments.length > 0) {
            let buff = TrimId.fromBase32Hex(init_inst_id);
            if (buff === null) {
                throw new TypeError("Given init id is invalid!");
            }
            inst_id = buff;
        }
        else {
            inst_id = TrimId.NEW;
        }
        __REDIPC.set(this, {
            silent: false,
            response_box_id: `_redipc.${inst_id.toString(32)}`,
            client: null,
            pubsub: null,
            task_map: new Map(),
            call_map: new Map(),
            channels: [],
            timeout: ThrottledTimeout(),
            timeout_dur: DEFAULT_TIMEOUT_DURATION
        });
    }
    get id() {
        return __REDIPC.get(this).response_box_id;
    }
    get connected() {
        const { client } = __REDIPC.get(this);
        return client === null ? false : client.connected;
    }
    set timeout(second) {
        const _REDIPC = __REDIPC.get(this);
        _REDIPC.timeout_dur = (second <= 0 ? 0 : second) * 1000;
    }
    get timeout() {
        return __REDIPC.get(this).timeout_dur;
    }
    close() {
        return __awaiter(this, void 0, void 0, function* () {
            const { client, pubsub, timeout } = __REDIPC.get(this);
            const promises = [];
            if (client !== null && client.connected) {
                promises.push(client.quit());
            }
            if (pubsub !== null && pubsub.connected) {
                promises.push(pubsub.quit());
            }
            timeout.clear();
            return Promise.all(promises);
        });
    }
    register(func, handler) {
        const { call_map } = __REDIPC.get(this);
        if (typeof func !== "string") {
            if (Object(func) === func) {
                for (const key in func) {
                    const callable = func[key];
                    if (typeof callable !== "function")
                        continue;
                    call_map.set(key, func[key]);
                }
            }
        }
        else if (typeof handler === "function") {
            call_map.set('' + func, handler);
        }
        return this;
    }
    remoteCall(channel, func, ...args) {
        return __awaiter(this, void 0, void 0, function* () {
            const { response_box_id, client, task_map, timeout_dur } = __REDIPC.get(this);
            if (!client)
                throw new Error("REDIPC instance is not initialized yet!");
            const id = TrimId.NEW.toString(32);
            const timestamp = Date.now();
            const call_job = Object.assign({ id, time: timestamp, timeout: null }, GenPromise());
            task_map.set(id, call_job);
            yield REDISRPush(client, channel, Beson.Serialize({
                id, src: response_box_id,
                func, args, timestamp
            }));
            yield REDISPublish(client, channel, id);
            call_job.timeout = setTimeout(() => {
                task_map.delete(id);
                call_job.reject(new REDISTimeoutError(id, channel, func, timestamp));
            }, timeout_dur);
            return call_job.promise;
        });
    }
    remoteEvent(channel, event, ...args) {
        return __awaiter(this, void 0, void 0, function* () {
            const { response_box_id, client, task_map } = __REDIPC.get(this);
            if (!client)
                throw new Error("REDIPC instance is not initialized yet!");
            const event_info = {
                id: TrimId.NEW.toString(32), src: response_box_id,
                evt: event, args, timestamp: Date.now()
            };
            yield REDISPublish(client, channel, Beson.Serialize(event_info));
        });
    }
    static init(options) {
        return __awaiter(this, void 0, void 0, function* () {
            if (Object(options) !== options) {
                throw new TypeError("Given connection options must be a key-value object!");
            }
            return Promise.resolve().then(() => __awaiter(this, void 0, void 0, function* () {
                const inst = new REDIPC();
                const { redis, channels: _channels, silent } = options;
                const channels = Array.isArray(_channels) ? _channels.slice(0) : [];
                channels.unshift(inst.id);
                const _REDIPC = __REDIPC.get(inst);
                _REDIPC.silent = !!silent;
                _REDIPC.channels = channels;
                if (typeof options.timeout === "number") {
                    inst.timeout = options.timeout;
                }
                const { uri: redis_uri, detect_buffers: _ } = redis;
                const { timeout, response_box_id } = _REDIPC;
                const client = _REDIPC.client = REDIS.createClient({
                    url: redis_uri, detect_buffers: true
                });
                const sub_client = _REDIPC.pubsub = _REDIPC.client.duplicate();
                sub_client.on('message_buffer', (_, data) => {
                    const channel_data = Beson.Deserialize(data);
                    timeout(() => {
                        if (channel_data !== undefined && channel_data !== null) {
                            return HandleEvent.call(inst, channel_data);
                        }
                        return HandleMessage.call(inst);
                    }, 0);
                });
                yield REDISSubscribe(sub_client, channels);
                setTimeout(() => REDISPublish(client, response_box_id, NULL_BESON), 100);
                return inst;
            }));
        });
    }
}
exports.default = REDIPC;
;
function HandleMessage() {
    const { client, response_box_id, timeout, channels } = __REDIPC.get(this);
    return Promise.resolve().then(() => __awaiter(this, void 0, void 0, function* () {
        for (let i = 0; i < BATCH_COUNT; i++) {
            let proc_data_count = 0;
            for (const channel of channels) {
                const data = yield REDISLPop(client, Buffer.from(channel));
                if (!data)
                    continue;
                proc_data_count++;
                const result = Beson.Deserialize(data);
                if (result === null || result === undefined || Object(result) !== result)
                    continue;
                const { id, func, args, err, res } = result;
                if (typeof id !== "string")
                    continue;
                if (func !== undefined || args !== undefined) {
                    yield HandleRequest.call(this, result);
                }
                else if (response_box_id === channel) {
                    yield HandleResponse.call(this, result);
                }
                else {
                    continue;
                }
            }
            if (proc_data_count === 0)
                return;
        }
        timeout(HandleMessage.bind(this), 0);
    })).catch((e) => console.error(e));
}
function HandleRequest(result) {
    return __awaiter(this, void 0, void 0, function* () {
        const { call_map, client, silent, timeout_dur } = __REDIPC.get(this);
        const { id, src, func, args, timestamp } = result;
        if (typeof id !== "string" || typeof src !== "string" || typeof func !== "string" || !Array.isArray(args) || typeof timestamp !== "number")
            return;
        if ((Date.now() - timestamp) > timeout_dur)
            return;
        const handler = call_map.get(func);
        if (!handler) {
            const error = {
                code: 'redipc#func-undefined',
                message: `Requested function '${func}' is not defined`,
                callstack: '',
                detail: { func }
            };
            yield REDISRPush(client, src, Beson.Serialize({ id, err: error }));
            yield REDISPublish(client, src, id);
            return;
        }
        return Promise.resolve()
            .then(() => handler(...args))
            .then((result) => __awaiter(this, void 0, void 0, function* () {
            yield REDISRPush(client, src, Beson.Serialize({ id, res: result }));
            yield REDISPublish(client, src, id);
        }))
            .catch((e) => __awaiter(this, void 0, void 0, function* () {
            if (!silent)
                console.error(e);
            const error = { code: '', message: '', callstack: '' };
            if (e instanceof Error || Object(e) === e) {
                const { code, message, callstack, stack, detail } = e;
                Object.assign(error, e, {
                    code: code || 'redipc#exec-error',
                    message: message || 'Unexpected execution error!',
                    callstack: callstack || stack || '',
                    detail
                });
            }
            else {
                Object.assign(error, {
                    code: 'redipc#exec-error',
                    message: 'Unexpected execution error!',
                    detail: e
                });
            }
            yield REDISRPush(client, src, Beson.Serialize({ id, err: error }));
            yield REDISPublish(client, src, id);
        }));
    });
}
function HandleResponse(result) {
    const { task_map } = __REDIPC.get(this);
    const { id, err, res } = result;
    const task = task_map.get(id);
    if (!task)
        return;
    task_map.delete(id);
    if (task.timeout) {
        clearTimeout(task.timeout);
        task.timeout = null;
    }
    const { resolve, reject } = task;
    if (err) {
        reject(new REDIPCError(err));
    }
    else {
        resolve(res);
    }
}
function HandleEvent(evt_data) {
    const { id, src, evt, args } = evt_data;
    if (typeof id !== "string" || typeof src !== "string" || typeof evt !== "string" || !Array.isArray(args))
        return;
    this.emit(evt, { event: evt, id, src }, ...args);
}
function GenPromise() {
    const p = {};
    p.promise = new Promise((res, rej) => {
        p.resolve = res;
        p.reject = rej;
    });
    return p;
}
function ThrottledTimeout() {
    let hTimeout = null, nextTask = null, running = false;
    const timeout = function (cb, delay = 0, ...args) {
        if (hTimeout) {
            if (running) {
                nextTask = { cb, delay, args };
                return;
            }
            else {
                clearTimeout(hTimeout);
            }
        }
        hTimeout = setTimeout(() => {
            running = true;
            Promise.resolve()
                .then(() => cb())
                .finally(() => {
                running = false;
                hTimeout = !nextTask ? null : setTimeout(nextTask.cb, nextTask.delay, ...nextTask.args);
                nextTask = null;
            });
        }, delay, ...args);
    };
    timeout.clear = function () {
        clearTimeout(hTimeout);
        nextTask = null;
        running = false;
    };
    return timeout;
}
function REDISSubscribe(client, channel) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            client.subscribe(channel, (err, result) => {
                err ? reject(err) : resolve(result);
            });
        });
    });
}
function REDISPublish(client, channel, value) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            if (value instanceof Uint8Array) {
                value = Buffer.from(value);
            }
            client.publish(channel, value, (err, result) => {
                err ? reject(err) : resolve(result);
            });
        });
    });
}
function REDISRPush(client, slot_id, ...data) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            const set_data = [];
            for (const raw_data of data) {
                if (raw_data instanceof Uint8Array) {
                    set_data.push(Buffer.from(raw_data));
                }
                else if (raw_data instanceof ArrayBuffer) {
                    set_data.push(Buffer.from(raw_data));
                }
                else {
                    set_data.push(raw_data);
                }
            }
            client.rpush(slot_id, ...set_data, (err, result) => {
                err ? reject(err) : resolve(result);
            });
        });
    });
}
function REDISLPop(client, slot_id) {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            client.lpop(slot_id, (err, result) => {
                err ? reject(err) : resolve(result);
            });
        });
    });
}
