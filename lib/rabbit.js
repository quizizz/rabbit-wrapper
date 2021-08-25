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
            this.log(`Subscribin to ${qid}`);
            return ch.consume(qid, msg => {
                const message = {
                    content: safely_parse_json_1.default(msg.content.toString()),
                    replyTo: msg.properties.replyTo,
                    rKey: msg.fields.routingKey,
                    correlationId: msg.properties.correlationId,
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
    * @param {boolean} handle=true - handle the effect to
    *
    * @return {Promise}
    */
    send(qname, message, options, handle = true) {
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
        return safely_parse_json_1.default(message.content.toString());
    }
}
module.exports = Rabbit;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmFiYml0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3JhYmJpdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7O0FBQ0Esc0ZBQXlHO0FBQ3pHLDBFQUF5QztBQXdCekM7O0dBRUc7QUFDSCxNQUFNLE1BQU07SUFPVjs7OztPQUlHO0lBQ0gsWUFBWSxJQUFZLEVBQUUsT0FBcUIsRUFBRSxNQUFvQjtRQUNuRSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztRQUNqQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztRQUV2QixJQUFJLENBQUMsTUFBTSxHQUFHO1lBQ1osS0FBSyxFQUFFLENBQUMsV0FBVyxDQUFDO1lBQ3BCLElBQUksRUFBRSxJQUFJO1lBQ1YsR0FBRyxNQUFNO1lBQ1QsSUFBSSxFQUFFO2dCQUNKLDBCQUEwQixFQUFFLENBQUM7Z0JBQzdCLHNCQUFzQixFQUFFLENBQUM7Z0JBQ3pCLEdBQUcsQ0FBQyxNQUFNLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSTthQUN2QjtTQUNGLENBQUM7UUFFRixJQUFJLENBQUMsTUFBTSxHQUFHLEVBQUUsQ0FBQyxDQUFDLGtDQUFrQztRQUNwRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztRQUNuQixJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQyxDQUFDLDJCQUEyQjtJQUNsRCxDQUFDO0lBRUQsR0FBRyxDQUFDLE9BQWUsRUFBRSxJQUFVO1FBQzdCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRTtZQUN2QixPQUFPLEVBQUUsSUFBSSxDQUFDLElBQUk7WUFDbEIsT0FBTztZQUNQLElBQUk7U0FDTCxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsT0FBTyxDQUFDLE9BQWUsRUFBRSxJQUFVO1FBQ2pDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRTtZQUMzQixPQUFPLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUUsSUFBSTtTQUNsQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsS0FBSyxDQUFDLEdBQVUsRUFBRSxJQUFVO1FBQzFCLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRTtZQUN6QixPQUFPLEVBQUUsSUFBSSxDQUFDLElBQUk7WUFDbEIsSUFBSTtZQUNKLEdBQUc7U0FDSixDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILGNBQWM7UUFDWixNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSSxDQUFDO1FBQ3hCLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxTQUFTO1lBQzlDLEdBQUcsTUFBTSxDQUFDLElBQUksR0FBRztZQUNqQixHQUFHLE1BQU0sQ0FBQyxRQUFRLEdBQUc7WUFDckIsR0FBRyxJQUFJLEdBQUc7WUFDVixHQUFHLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FDakIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxFQUFFLElBQUksRUFBRSxHQUFHLE1BQU0sQ0FBQztRQUN4QixNQUFNLElBQUksR0FBRztZQUNYLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSztZQUNuQixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUk7WUFDakIsSUFBSTtTQUNMLENBQUM7UUFDRixPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1lBQ3JDLElBQUksQ0FBQyxHQUFHLENBQUMsZUFBZSxFQUFFO2dCQUN4QixJQUFJO2FBQ0wsQ0FBQyxDQUFDO1lBQ0gsTUFBTSxVQUFVLEdBQUcsaUNBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQzVDLFVBQVUsQ0FBQyxFQUFFLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxFQUFFO2dCQUM5QixNQUFNLE9BQU8sR0FBRyxnQkFBZ0IsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO2dCQUMzQyxJQUFJLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQztnQkFDNUIsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDO1lBQ3RCLENBQUMsQ0FBQyxDQUFDO1lBQ0gsVUFBVSxDQUFDLEVBQUUsQ0FBQyxZQUFZLEVBQUUsTUFBTSxDQUFDLEVBQUU7Z0JBQ25DLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsQ0FBQztnQkFDN0IsTUFBTSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNyQixDQUFDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7Ozs7OztPQVFHO0lBQ0gsV0FBVyxDQUFDLEVBQXFCO1FBQy9CLE1BQU0sSUFBSSxHQUFzQjtZQUM5QixJQUFJLEVBQUUsSUFBSTtZQUNWLEdBQUcsRUFBRTtTQUNOLENBQUM7UUFFRixPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1lBQ3JDLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2hELE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUM7WUFDOUIsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsR0FBRyxDQUFDLEVBQUU7Z0JBQ3hCLElBQUksR0FBRyxFQUFFO29CQUNQLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO3dCQUNkLFdBQVc7cUJBQ1osQ0FBQyxDQUFDO2lCQUNKO2dCQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNkLENBQUMsQ0FBQyxDQUFDO1lBQ0gsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPLEVBQUUsR0FBRyxDQUFDLEVBQUU7Z0JBQ3hCLElBQUksR0FBRyxFQUFFO29CQUNQLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO3dCQUNkLFdBQVc7cUJBQ1osQ0FBQyxDQUFDO2lCQUNKO2dCQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNkLENBQUMsQ0FBQyxDQUFDO1lBQ0gsT0FBTyxDQUFDLEVBQUUsQ0FBQyxNQUFNLEVBQUUsT0FBTyxDQUFDLEVBQUU7Z0JBQzNCLE1BQU0sS0FBSyxHQUFHLElBQUksS0FBSyxDQUFDLEdBQUcsV0FBVyw2QkFBNkIsQ0FBQyxDQUFDO2dCQUNyRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRTtvQkFDaEIsV0FBVztvQkFDWCxjQUFjLEVBQUUsT0FBTztpQkFDeEIsQ0FBQyxDQUFDO1lBQ0wsQ0FBQyxDQUFDLENBQUM7WUFDSCxPQUFPLENBQUMsRUFBRSxDQUFDLFNBQVMsRUFBRSxHQUFHLEVBQUU7Z0JBQ3pCLE1BQU0sT0FBTyxHQUFHLElBQUksV0FBVyxxQkFBcUIsQ0FBQztnQkFDckQsSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUU7b0JBQ2hCLFdBQVc7aUJBQ1osQ0FBQyxDQUFDO2dCQUNILE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUNuQixDQUFDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7O01BSUU7SUFDRixJQUFJO1FBQ0YsSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ2YsT0FBTyxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO1NBQzlCO1FBRUQscUJBQXFCO1FBQ3JCLE9BQU8sSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLFVBQVUsRUFBRSxFQUFFO1lBQy9DLElBQUksQ0FBQyxNQUFNLEdBQUcsVUFBVSxDQUFDO1lBQ3pCLE9BQU8sSUFBSSxDQUFDLFdBQVcsQ0FBQztnQkFDdEIsSUFBSSxFQUFFLFFBQVE7Z0JBQ2QsSUFBSSxFQUFFLElBQUk7YUFDWCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTtZQUNsQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztZQUN2QixPQUFPLElBQUksQ0FBQztRQUNkLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7Ozs7Ozs7TUFTRTtJQUNGLEtBQUssQ0FBQyxXQUFXLENBQUMsU0FBaUIsRUFBRSxFQUF3QjtRQUMzRCxNQUFNLElBQUksR0FBRztZQUNYLE9BQU8sRUFBRSxJQUFJO1lBQ2IsVUFBVSxFQUFFLEtBQUs7WUFDakIsR0FBRyxFQUFFO1NBQ04sQ0FBQztRQUNGLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQzVCLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQztRQUNsQixNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUM7WUFDckMsSUFBSSxFQUFFLFNBQVM7WUFDZixJQUFJLEVBQUUsSUFBSTtZQUNWLEtBQUssRUFBRSxTQUFTLEtBQUssQ0FBQyxFQUFrQjtnQkFDdEMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDZixpQkFBaUI7Z0JBQ2pCLE9BQU8sRUFBRSxDQUFDLFdBQVcsQ0FBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFO29CQUM5QyxNQUFNLE9BQU8sR0FBRyxJQUFJLFNBQVMsaUJBQWlCO3dCQUMxQyxJQUFJLENBQUMsQ0FBQyxhQUFhLGdCQUFnQixDQUFDLENBQUMsWUFBWSxXQUFXLENBQUM7b0JBQ2pFLElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxFQUFFO3dCQUNoQixTQUFTO3dCQUNULGFBQWEsRUFBRSxDQUFDLENBQUMsYUFBYTt3QkFDOUIsWUFBWSxFQUFFLENBQUMsQ0FBQyxZQUFZO3FCQUM3QixDQUFDLENBQUM7b0JBQ0gsT0FBTyxJQUFJLENBQUM7Z0JBQ2QsQ0FBQyxDQUFDLENBQUM7WUFDTCxDQUFDO1NBQ0YsQ0FBQyxDQUFBO1FBRUYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3pDLE9BQU8sT0FBTyxDQUFDO0lBQ2pCLENBQUM7SUFHRDs7Ozs7OztNQU9FO0lBQ0YsU0FBUyxDQUFDLEdBQVcsRUFBRSxFQUF5QztRQUM5RCxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzNCLE9BQU8sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFrQixFQUFFLEVBQUU7WUFDL0MsSUFBSSxDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsR0FBRyxFQUFFLENBQUMsQ0FBQztZQUNqQyxPQUFPLEVBQUUsQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxFQUFFO2dCQUMzQixNQUFNLE9BQU8sR0FBRztvQkFDZCxPQUFPLEVBQUUsMkJBQVEsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDO29CQUN6QyxPQUFPLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxPQUFPO29CQUMvQixJQUFJLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxVQUFVO29CQUMzQixhQUFhLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxhQUFhO29CQUMzQyxHQUFHLEVBQUUsR0FBRyxFQUFFO3dCQUNSLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO29CQUNyQixDQUFDO29CQUNELElBQUksRUFBRSxHQUFHLEVBQUU7d0JBQ1QsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7b0JBQ3RCLENBQUM7aUJBQ0YsQ0FBQztnQkFDRixFQUFFLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDZCxDQUFDLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7Ozs7O09BT0c7SUFDSCxLQUFLLENBQUMsV0FBVyxDQUFDLEtBQWEsRUFBRSxHQUFXO1FBQzFDLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDN0IsYUFBYTtRQUNiLE1BQU0sT0FBTyxHQUFZLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBbUIsQ0FBQztRQUN2RCxNQUFNLE9BQU8sQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDNUIsQ0FBQztJQUVEOzs7Ozs7Ozs7OztNQVdFO0lBQ0YsS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFXLEVBQUUsT0FBZ0MsRUFBRSxPQUF3QixFQUFFLE1BQU0sR0FBRyxJQUFJO1FBQ2xHLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDM0IsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsR0FBRyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztRQUN2RCxJQUFJLE1BQU0sS0FBSyxLQUFLLEVBQUU7WUFDcEIsT0FBTyxDQUFDLENBQUM7U0FDVjtRQUNELE1BQU0sQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFO1lBQ2xCLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO2dCQUNkLFNBQVMsRUFBRSxHQUFHO2dCQUNkLE9BQU87Z0JBQ1AsT0FBTzthQUNSLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztJQUVEOzs7Ozs7Ozs7OztNQVdFO0lBQ0YsSUFBSSxDQUFDLEtBQWEsRUFBRSxPQUFnQyxFQUFFLE9BQXdCLEVBQUUsTUFBTSxHQUFHLElBQUk7UUFDM0YsTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsS0FBSyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztRQUM1RCxJQUFJLE1BQU0sS0FBSyxLQUFLLEVBQUU7WUFDcEIsT0FBTyxDQUFDLENBQUM7U0FDVjtRQUVELE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUU7UUFDbkIsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFO1lBQ2IsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQ2QsU0FBUyxFQUFFLEtBQUs7Z0JBQ2hCLE9BQU87Z0JBQ1AsT0FBTzthQUNSLENBQUMsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7Ozs7TUFNRTtJQUNGLEtBQUssQ0FBQyxVQUFVLENBQUksS0FBYTtRQUMvQixhQUFhO1FBQ2IsTUFBTSxPQUFPLEdBQVksSUFBSSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUM7UUFDL0MsTUFBTSxPQUFPLEdBQUcsTUFBTSxPQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFBO1FBQ3pELElBQUksT0FBTyxLQUFLLEtBQUssRUFBRTtZQUNyQixNQUFNLElBQUksS0FBSyxDQUFDLGlCQUFpQixLQUFLLEVBQUUsQ0FBQyxDQUFDO1NBQzNDO1FBQ0QsT0FBTywyQkFBUSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUM5QyxDQUFDO0NBQ0Y7QUFFRCxpQkFBUyxNQUFNLENBQUMifQ==