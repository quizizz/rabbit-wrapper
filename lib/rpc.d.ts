/// <reference types="node" />
import events from 'events';
import Rabbit from './rabbit';
import { ChannelWrapper } from 'amqp-connection-manager';
interface RPCConfig {
    request: string;
    reply: string;
}
/**
 * @class RRPC
 */
declare class RPC {
    name: string;
    emitter: events.EventEmitter;
    config: RPCConfig;
    rabbit: Rabbit;
    requestQ: ChannelWrapper;
    replyQ: ChannelWrapper;
    callbacks: {
        [_: string]: (value: unknown) => any;
    };
    /**
     * @param {string} name - unique name to this service
     * @param {EventEmitter} emitter
     * @param {Object} config - configuration object of service
     */
    constructor(name: any, emitter: any, config: any, rabbit: Rabbit);
    log(message: string, data?: Record<string, unknown>): void;
    success(message: string, data?: Record<string, unknown>): void;
    error(err: Error, data?: Record<string, unknown>): void;
    /**
     * Initialize this rpc
     *
     * @return {Promise<this>}
     */
    init(): Promise<void>;
    /**
     * Make a request in rpc system with given name
     *
     * @param {string} name
     * @param {Object} message
     *
     * @param {Promise}
     */
    request(message: Record<string, unknown>): Promise<unknown>;
    /**
     * subscribe to the queue and also call the associated callback when needed
     *
     * @param {string} qname
     */
    subscribe(qname: string): Promise<void>;
}
export = RPC;
