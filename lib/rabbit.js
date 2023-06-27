"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const amqp_connection_manager_1 = __importDefault(require("amqp-connection-manager"));
const safely_parse_json_1 = __importDefault(require("safely-parse-json"));
/**
 * @class Rabbit
 */
class Rabbit {
    name;
    emitter;
    config;
    queues;
    client;
    channel;
    /**
     * @param {string} name - unique name to this service
     * @param {EventEmitter} emitter
     * @param {Object} config - configuration object of service
     */
    constructor(name, emitter, config) {
        this.name = name;
        this.emitter = emitter;
        this.config = {
            hosts: ['localhost'],
            port: 5672,
            ...config,
            opts: {
                heartbeatIntervalInSeconds: 5,
                reconnectTimeInSeconds: 2,
                ...(config || {}).opts,
            },
        };
        this.queues = {}; // Queue name to queue channel map
        this.client = null;
        this.channel = null; // A global helping channel
    }
    log(message, data) {
        this.emitter.emit('log', {
            service: this.name,
            message,
            data,
        });
    }
    success(message, data) {
        this.emitter.emit('success', {
            service: this.name, message, data,
        });
    }
    error(err, data) {
        this.emitter.emit('error', {
            service: this.name,
            data,
            err,
        });
    }
    /**
     * Make connection to server
     *
     * @return {Promise<connection, Error>} resolves with the connection object
     */
    makeConnection() {
        const { config } = this;
        const urls = config.hosts.map(host => ('amqp://' +
            `${config.user}:` +
            `${config.password}@` +
            `${host}:` +
            `${config.port}`));
        const { opts } = config;
        const info = {
            hosts: config.hosts,
            port: config.port,
            opts,
        };
        return new Promise((resolve, reject) => {
            this.log('Connecting to', {
                urls,
            });
            const connection = amqp_connection_manager_1.default.connect(urls, opts);
            connection.on('connect', data => {
                const message = `Connected to ${data.url}`;
                this.success(message, info);
                resolve(connection);
            });
            connection.on('disconnect', params => {
                this.error(params.err, urls);
                reject(params.err);
            });
        });
    }
    /**
     * Make a channel
     *
     * @param {Object} opts - the options for channel
     * @param {string} opts.name - name of the channel
     * @param {boolean} opts.json - whether to use JSON transformations
     *
     * @return {Promise<channel, Error>} resolves with the channel created
     */
    makeChannel(op) {
        const opts = {
            json: true,
            ...op,
        };
        return new Promise((resolve, reject) => {
            const channel = this.client.createChannel(opts);
            const channelName = opts.name;
            channel.on('close', err => {
                if (err) {
                    this.error(err, {
                        channelName,
                    });
                }
                reject(err);
            });
            channel.on('error', err => {
                if (err) {
                    this.error(err, {
                        channelName,
                    });
                }
                reject(err);
            });
            channel.on('drop', message => {
                const error = new Error(`${channelName} channel :: dropped message`);
                this.error(error, {
                    channelName,
                    droppedMessage: message,
                });
            });
            channel.on('connect', () => {
                const message = `<${channelName}> channel :: opened`;
                this.log(message, {
                    channelName,
                });
                resolve(channel);
            });
        });
    }
    /**
    * Connect to the rabbit server
    *
    * @return {Promise<Object, Error>} - resolves with this instance
    */
    init() {
        if (this.client) {
            return Promise.resolve(this);
        }
        // Connect the client
        return this.makeConnection().then((connection) => {
            this.client = connection;
            return this.makeChannel({
                name: 'global',
                json: true,
            });
        }).then((channel) => {
            this.channel = channel;
            return this;
        });
    }
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
    async createQueue(queueName, op) {
        const opts = {
            durable: true,
            autoDelete: false,
            ...op,
        };
        this.queues[queueName] = {};
        const self = this;
        const channel = await this.makeChannel({
            name: queueName,
            json: true,
            setup: function setup(ch) {
                ch.prefetch(1);
                // Create a queue
                return ch.assertQueue(queueName, opts).then(q => {
                    const message = `"${queueName}" -> created ->` +
                        ` ${q.consumerCount} consumers & ${q.messageCount} messages`;
                    self.log(message, {
                        queueName,
                        consumerCount: q.consumerCount,
                        messageCount: q.messageCount,
                    });
                    return this;
                });
            },
        });
        this.queues[queueName].channel = channel;
        return channel;
    }
    /**
    * Subscribe to a queue, queue should be created in this instance only
    *
    * @param {string} qid  - name of the queue
    * @param {Function} cb - allback to handle the message
    *
    * @return {Promise}
    */
    subscribe(qid, cb) {
        const q = this.queues[qid];
        return q.channel.addSetup((ch) => {
            this.log(`Subscribing to ${qid}`);
            return ch.consume(qid, msg => {
                const message = {
                    content: (0, safely_parse_json_1.default)(msg.content.toString()),
                    replyTo: msg.properties.replyTo,
                    rKey: msg.fields.routingKey,
                    correlationId: msg.properties.correlationId,
                    meta: msg.properties.headers,
                    ack: () => {
                        q.channel.ack(msg);
                    },
                    nack: () => {
                        q.channel.nack(msg);
                    },
                };
                cb(message);
            });
        });
    }
    /**
     * Unsubscribe from queue, should be created in this instacne
     *
     * @param {string} qName - name of the queue
     * @param {string} tag - consumer tag for subscriber
     *
     * @return {Promise}
     */
    async unsubscribe(qName, tag) {
        const q = this.queues[qName];
        // @ts-ignore
        const channel = q.channel._channel;
        await channel.cancel(tag);
    }
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
    async publish(qid, message, options, handle = true) {
        const q = this.queues[qid];
        const p = q.channel.sendToQueue(qid, message, options);
        if (handle === false) {
            return p;
        }
        await p.catch((err) => {
            this.error(err, {
                queueName: qid,
                message,
                options,
            });
        });
    }
    /**
    * Publish message to a queue, doesn't matter if the queue even exists or not
    *
    * @param {string} queueName - name of the queue
    * @param {Object} message - the message to publish
    * @param {Object} options - the name of the reply queue, correlationId
    * @param {string} options.replyTo - the name of reply queue
    * @param {string} options.correlationId
    * @param {Object} meta - meta contains message properties like traceId, reqStartTime
    * @param {string} meta.traceId
    * @param {string} meta.reqStartTime - the time when request initiated in our system
    * @param {boolean} handle=true - handle the effect to
    *
    * @return {Promise}
    */
    send(qname, message, options, meta = {}, handle = true) {
        options.headers = {
            ...options.headers,
            ...meta,
        };
        const p = this.channel.sendToQueue(qname, message, options);
        if (handle === false) {
            return p;
        }
        return p.then(() => {
        }).catch(err => {
            this.error(err, {
                queueName: qname,
                message,
                options,
            });
        });
    }
    /**
    * Get a message from a queue, just get it
    *
    * @param {string} qname - name of the queue
    *
    * @return {Promise} - resolve with mesasge message
    */
    async getMessage(qname) {
        // @ts-ignore
        const channel = this.channel._channel;
        const message = await channel.get(qname, { noAck: true });
        if (message === false) {
            throw new Error(`No message on ${qname}`);
        }
        return (0, safely_parse_json_1.default)(message.content.toString());
    }
}
module.exports = Rabbit;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmFiYml0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3JhYmJpdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQ0Esc0ZBQXlHO0FBQ3pHLDBFQUF5QztBQXlCekM7O0dBRUc7QUFDSCxNQUFNLE1BQU07SUFDVixJQUFJLENBQVM7SUFDYixPQUFPLENBQWU7SUFDdEIsTUFBTSxDQUFlO0lBQ3JCLE1BQU0sQ0FBNkM7SUFDbkQsTUFBTSxDQUF3QjtJQUM5QixPQUFPLENBQWlCO0lBQ3hCOzs7O09BSUc7SUFDSCxZQUFZLElBQVksRUFBRSxPQUFxQixFQUFFLE1BQW9CO1FBQ25FLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBQ2pCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBRXZCLElBQUksQ0FBQyxNQUFNLEdBQUc7WUFDWixLQUFLLEVBQUUsQ0FBQyxXQUFXLENBQUM7WUFDcEIsSUFBSSxFQUFFLElBQUk7WUFDVixHQUFHLE1BQU07WUFDVCxJQUFJLEVBQUU7Z0JBQ0osMEJBQTBCLEVBQUUsQ0FBQztnQkFDN0Isc0JBQXNCLEVBQUUsQ0FBQztnQkFDekIsR0FBRyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJO2FBQ3ZCO1NBQ0YsQ0FBQztRQUVGLElBQUksQ0FBQyxNQUFNLEdBQUcsRUFBRSxDQUFDLENBQUMsa0NBQWtDO1FBQ3BELElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1FBQ25CLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLENBQUMsMkJBQTJCO0lBQ2xELENBQUM7SUFFRCxHQUFHLENBQUMsT0FBZSxFQUFFLElBQVU7UUFDN0IsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFO1lBQ3ZCLE9BQU8sRUFBRSxJQUFJLENBQUMsSUFBSTtZQUNsQixPQUFPO1lBQ1AsSUFBSTtTQUNMLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxPQUFP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