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
const redipc_js_1 = require("../redipc.js");
Promise.resolve().then(() => __awaiter(void 0, void 0, void 0, function* () {
    const REDIPC = yield redipc_js_1.default.init({ redis: { uri: 'redis://192.168.3.29:6379/0' }, timeout: 10 });
    console.log("inst_id", REDIPC.id);
    REDIPC.register('hi_back', (...args) => { console.log("Receiving hi_back:", args); return "Hi Back!"; });
    console.log("test1 say_hi:", yield REDIPC.remoteCall('test1', 'say_hi', 'test1', 1, 2, 3));
    console.log("test2 say_hi:", yield REDIPC.remoteCall('test2', 'say_hi', 'test2', { a: 1, b: 2, c: 3, d: 456 }));
    console.log("test3 say_hi2:", yield REDIPC.remoteCall('test2', 'say_hi_error').catch(e => e));
    REDIPC.on('super_event_back', (event, ...args) => {
        console.log("Receiving event:", event, args);
    });
    yield REDIPC.remoteEvent('test1', 'super_event', 1, 2, 3, 4, 5);
    setTimeout(() => __awaiter(void 0, void 0, void 0, function* () {
        yield REDIPC.close();
    }), 1000);
}))
    .catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
