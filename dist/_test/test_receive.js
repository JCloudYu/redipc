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
    const REDIPC = yield redipc_js_1.default.init({ redis: { uri: 'redis://192.168.3.29:6379/0' }, channels: ['test1', 'test2'], timeout: 5 });
    console.log("inst_id", REDIPC.id);
    REDIPC.register('say_hi', (...args) => { console.log("Receiving say_hi:", args); return "Hi!"; });
    REDIPC.register('say_hi_error', (...args) => { throw new Error("Super error!"); });
    REDIPC.on('super_event', (event, ...args) => __awaiter(void 0, void 0, void 0, function* () {
        console.log("Receiving event:", event, args);
        yield REDIPC.remoteEvent(event.src, 'super_event_back', ...args, 'a', 'b', 'c', 'd', 'e');
        console.log("test1 say_hi:", yield REDIPC.remoteCall(event.src, 'hi_back', 'hi', 'back', 3, 2, 1));
    }));
}))
    .catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
