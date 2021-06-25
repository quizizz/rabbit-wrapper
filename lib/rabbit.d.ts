/// <reference types="node" />
import amqp, { AmqpConnectionManager, ChannelWrapper, CreateChannelOpts } from 'amqp-connection-manager';
import EventEmitter from 'events';
import { Options } from 'amqplib';
interface RabbitConfig {
    hosts?: string[];
    port?: number;
    user: string;
    password: string;
    opts?: {
        heartbeatIntervalInSeconds?: number;
        reconnectTimeInSeconds?: number;
    };
}
interface SubscribeCallbackArgs {
    content: any;
    replyTo: any;
    rKey: string;
    correlationId: any;
    ack: () => void;
    nack: () => void;
}
/**
 * @class Rabbit
 */
declare class Rabbit {
    name: string;
    emitter: EventEmitter;
    config: RabbitConfig;
    queues: {
        [_: string]: {
            channel?: ChannelWrapper;
        };
    };
    client: AmqpConnectionManager;
    channel: ChannelWrapper;
    /**
     * @param {string} name - unique name to this service
     * @param {EventEmitter} emitter
     * @param {Object} config - configuration object of service
     */
    constructor(name: string, emitter: EventEmitter, config: RabbitConfig);
    log(message: string, data?: any): void;
    success(message: string, data?: any): void;
    error(err: Error, data?: any): void;
    /**
     * Make connection to server
     *
     * @return {Promise<connection, Error>} resolves with the connection object
     */
    makeConnection(): Promise<AmqpConnectionManager>;
    /**
     * Make a channel
     *
     * @param {Object} opts - the options for channel
     * @param {string} opts.name - name of the channel
     * @param {boolean} opts.json - whether to use JSON transformations
     *
     * @return {Promise<channel, Error>} resolves with the channel created
     */
    makeChannel(op: CreateChannelOpts): Promise<ChannelWrapper>;
    /**
    * Connect to the rabbit server
    *
    * @return {Promise<Object, Error>} - resolves with this instance
    */
    init(): Promise<this>;
    /**
    * Create Queue, bind to exchange,
    *
    * @param {string} queueName - name of the queue to create
    * @param {Object} opts - queue behaviour defining options
    * @param {boolean} [opts.durable=true]
    * @param {boolean} [opts.autoDelete=false]
    *
    * @return {Promise<undefined>}
    */
    createQueue(queueName: string, op?: Options.AssertQueue): Promise<amqp.ChannelWrapper>;
    /**
    * Subscribe to a queue, queue should be created in this instance only
    *
    * @param {string} qid  - name of the queue
    * @param {Function} cb - allback to handle the message
    *
    * @return {Promise}
    */
    subscribe(qid: string, cb: (args: SubscribeCallbackArgs) => void): Promise<void>;
    /**
     * Unsubscribe from queue, should be created in this instacne
     *
     * @param {string} qName - name of the queue
     * @param {string} tag - consumer tag for subscriber
     *
     * @return {Promise}
     */
    unsubscribe(qName: string, tag: string): Promise<void>;
    /**
    * Publish message to a queue, queue should created in this instance only
    *
    * @param {string} queueName - name of the queue
    * @param {Object} message - the message to publish
    * @param {Object} options - the name of the reply queue, correlationId
    * @param {string} options.replyTo - the name of reply queue
    * @param {string} options.correlationId
    * @param {boolean} handle=true - handle the effect to
    *
    * @return {Promise}
    */
    publish(qid: string, message: Record<string, unknown>, options: Options.Publish, handle?: boolean): Promise<void>;
    /**
    * Publish message to a queue, doesn't matter if the queue even exists or not
    *
    * @param {string} queueName - name of the queue
    * @param {Object} message - the message to publish
    * @param {Object} options - the name of the reply queue, correlationId
    * @param {string} options.replyTo - the name of reply queue
    * @param {string} options.correlationId
    * @param {boolean} handle=true - handle the effect to
    *
    * @return {Promise}
    */
    send(qname: string, message: Record<string, unknown>, options: Options.Publish, handle?: boolean): Promise<void>;
    /**
    * Get a message from a queue, just get it
    *
    * @param {string} qname - name of the queue
    *
    * @return {Promise} - resolve with mesasge message
    */
    getMessage<T>(qname: string): Promise<T>;
}
export = Rabbit;
