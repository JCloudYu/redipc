/// <reference types="node" />
import Events = require('events');
declare type AnyObject = {
    [key: string]: any;
};
declare type AnyFunction = (...args: any[]) => void;
declare type REDIPCInitOptions = {
    redis: {
        uri: string;
    };
    channels?: string[];
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
    constructor(err_desc: REDISErrorDescriptor | Error);
}
export default class REDIPC extends Events.EventEmitter {
    constructor(init_inst_id?: string);
    get id(): string;
    get connected(): boolean;
    register(func: string | HandlerMap, handler?: AnyFunction): REDIPC;
    remoteCall(channel: string, func: string, ...args: any[]): Promise<any>;
    static init(options: REDIPCInitOptions): Promise<REDIPC>;
}
export {};
