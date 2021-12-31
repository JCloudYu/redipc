/// <reference types="node" />
import Events = require('events');
declare type AnyFunction = (...args: any[]) => void;
declare type REDIPCInitOptions = {
    redis: {
        uri: string;
        [key: string]: any;
    };
    channels?: string[];
    timeout?: number;
    silent?: boolean;
};
declare type REDIPCErrorLike = {
    code: string;
    message: string;
    callstack: string;
    detail?: any;
};
declare type HandlerMap = {
    [func: string]: AnyFunction;
};
export declare class REDIPCError extends Error {
    readonly code: string;
    readonly callstack: string;
    readonly detail?: any;
    constructor(err_desc: (Error & Partial<REDIPCErrorLike>) | REDIPCErrorLike);
}
export declare class REDISTimeoutError extends REDIPCError {
    readonly id: string;
    readonly channel: string;
    readonly func: string;
    readonly timestamp: number;
    constructor(msg_id: string, channel: string, func: string, timestamp: number);
}
export default class REDIPC extends Events.EventEmitter {
    constructor(init_inst_id?: string);
    get id(): string;
    get connected(): boolean;
    set timeout(second: number);
    get timeout(): number;
    close(): Promise<any[]>;
    register(map: HandlerMap): REDIPC;
    register(func: string, handler: AnyFunction): REDIPC;
    remoteCall<ReturnType = any>(channel: string, func: string, ...args: any[]): Promise<ReturnType>;
    remoteEvent(channel: string, event: string, ...args: any[]): Promise<void>;
    static init(options: REDIPCInitOptions): Promise<REDIPC>;
}
export {};
