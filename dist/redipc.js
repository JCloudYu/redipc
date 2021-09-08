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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REDISError = void 0;
const Events = require("events");
const Beson = require("beson");
const REDIS = require("redis");
const TrimId = require("trimid");
;
;
class REDISError extends Error {
    constructor(err_desc) {
        if (Object(err_desc) !== err_desc) {
            throw new Error("REDISError constructor accept only errors or error descriptors!");
        }
        let { code, message } = err_desc, additional = __rest(err_desc, ["code", "message"]);
        if (typeof message !== "string") {
            message = "Unkown error";
        }
        if (typeof code !== "string") {
            code = 'unkown-error';
        }
        super(message);
        this.code = code;
        Object.assign(this, additional);
    }
}
exports.REDISError = REDISError;
;
const BATCH_COUNT = 25;
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
            response_box_id: `_redipc.${inst_id.toString(32)}`,
            client: null,
            pubsub: null,
            task_map: new Map(),
            call_map: new Map(),
            timeout: ThrottledTimeout()
        });
    }
    get id() {
        return __REDIPC.get(this).response_box_id;
    }
    get connected() {
        const { client } = __REDIPC.get(this);
        return client === null ? false : client.connected;
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
            const { response_box_id, client, task_map } = __REDIPC.get(this);
            if (!client)
                throw new Error("REDIPC instance is not initialized yet!");
            const id = TrimId.NEW.toString(32);
            const timestamp = Date.now();
            const call_job = Object.assign({ id, time: timestamp }, GenPromise());
            task_map.set(id, call_job);
            yield REDISRPush(client, channel, Beson.Serialize({
                id, src: response_box_id,
                func, args, timestamp
            }));
            yield REDISPublish(client, channel, id);
            return call_job.promise;
        });
    }
    static init(options) {
        return __awaiter(this, void 0, void 0, function* () {
            if (Object(options) !== options) {
                throw new TypeError("Given connection options must be a key-value object!");
            }
            return Promise.resolve().then(() => __awaiter(this, void 0, void 0, function* () {
                const inst = new REDIPC();
                const { redis, channels: _channels } = options;
                const channels = Array.isArray(_channels) ? _channels.slice(0) : [];
                channels.push(inst.id);
                const _REDIPC = __REDIPC.get(inst);
                const { response_box_id, timeout } = _REDIPC;
                _REDIPC.client = REDIS.createClient({
                    url: redis.uri, detect_buffers: true
                });
                const client = _REDIPC.pubsub = _REDIPC.client.duplicate();
                client.on('message_buffer', (channel, data) => {
                    channel = channel.toString('utf8');
                    if (channel === response_box_id) {
                        timeout(HandleResponse.bind(inst), 0);
                    }
                    else {
                        timeout(HandleRequest.bind(inst, channel), 0);
                    }
                });
                yield REDISSubscribe(client, channels);
                return inst;
            }));
        });
    }
}
exports.default = REDIPC;
;
function HandleRequest(channel) {
    const { call_map, client, timeout } = __REDIPC.get(this);
    return Promise.resolve().then(() => __awaiter(this, void 0, void 0, function* () {
        for (let i = 0; i < BATCH_COUNT; i++) {
            const data = yield REDISLPop(client, Buffer.from(channel));
            if (!data)
                return;
            const result = Beson.Deserialize(data);
            if (result === null || result === undefined || Object(result) !== result)
                continue;
            const { id, src, func, args } = result;
            if (typeof id !== "string" || typeof src !== "string" || typeof func !== "string" || !Array.isArray(args))
                continue;
            const handler = call_map.get(func);
            if (!handler) {
                yield REDISRPush(client, src, Beson.Serialize({
                    id, err: {
                        code: 'error#func-undefined',
                        message: `Requested function '${func}' is not defined`,
                        func
                    }
                }));
                yield REDISPublish(client, src, id);
                continue;
            }
            Promise.resolve()
                .then(() => handler(...args))
                .then((result) => __awaiter(this, void 0, void 0, function* () {
                yield REDISRPush(client, src, Beson.Serialize({ id, res: result }));
                yield REDISPublish(client, src, id);
            }))
                .catch((e) => __awaiter(this, void 0, void 0, function* () {
                const error = {};
                if (e instanceof Error) {
                    error.code = e.code || 'exec-error';
                    error.message = e.message;
                    Object.assign(error, e);
                }
                else if (Object(e) === e) {
                    error.code = e.code || 'exec-error';
                    error.message = e.message || 'Unexpected execution error!';
                    Object.assign(error, e);
                }
                else {
                    error.code = 'exec-error';
                    error.message = 'Unexpected execution error!';
                    error._detail = e;
                }
                yield REDISRPush(client, src, Beson.Serialize({ id, err: error }));
                yield REDISPublish(client, src, id);
            }));
        }
        timeout(HandleRequest.bind(this, channel), 0);
    })).catch((e) => console.error(e));
}
function HandleResponse() {
    const { task_map, client, response_box_id, timeout } = __REDIPC.get(this);
    return Promise.resolve().then(() => __awaiter(this, void 0, void 0, function* () {
        for (let i = 0; i < BATCH_COUNT; i++) {
            const data = yield REDISLPop(client, Buffer.from(response_box_id));
            if (!data)
                return;
            const result = Beson.Deserialize(data);
            if (result === null || result === undefined || Object(result) !== result)
                continue;
            const { id, err, res } = result;
            const task = task_map.get(id);
            if (!task)
                continue;
            const { resolve, reject } = task;
            if (err !== undefined) {
                reject(new REDISError(err));
                continue;
            }
            resolve(res);
        }
        timeout(HandleResponse.bind(this), 0);
    }));
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
