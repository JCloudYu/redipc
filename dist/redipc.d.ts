/// <reference types="node" />
import Events = require('events');
declare type AnyObject = {
    [key: string]: any;
};
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
declare type REDISErrorDescriptor = {
    code?: string;
    message?: string;
} & AnyObject;
declare type HandlerMap = {
    [func: string]: AnyFunction;
};
export declare class REDISError extends Error {
    [key: string]: any;
    readonly code: string;
    constructor(err_desc: REDISErrorDescriptor);
}
export declare class REDISTimeoutError extends REDISError {
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
