
const amqp = require('amqp-connection-manager');

const Service = require('@akshendra/service');
const { safeJSON } = require('@akshendra/misc');
const { validate, joi } = require('@akshendra/validator');

/**
 * @class Rabbit
 */
class Rabbit extends Service {
  /**
   * @param {string} name - unique name to this service
   * @param {EventEmitter} emitter
   * @param {Object} config - configuration object of service
   */
  constructor(name, emitter, config) {
    super(name, emitter, config);

    this.config = validate(config, joi.object().keys({
      hosts: joi.array().items(joi.string()).default(['127.0.0.1']),
      port: joi.number().integer().min(0).default(5672),
      user: joi.string().required(),
      password: joi.string().required(),
      opts: joi.object().keys({
        heartbeatIntervalInSeconds: joi.number().integer().default(5),
        reconnectTimeInSeconds: joi.number().integer().default(2),
      }).default({
        heartbeatIntervalInSeconds: 5,
        reconnectTimeInSeconds: 2,
      }),
    }));

    this.queues = {}; // Queue name to queue channel map
    this.client = null;
    this.channel = null; // A global helping channel
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
      `${config.port}`
    ));
    const { opts } = config;
    const info = {
      hosts: config.hosts,
      port: config.port,
      opts,
    };
    return new Promise((resolve, reject) => {
      this.log.info('Connecting to', urls);
      const connection = amqp.connect(urls, opts);
      connection.on('connect', data => {
        const message = `Connected to ${data.url}`;
        this.log.info(message);
        this.emitInfo('connected', message, info);
        resolve(connection);
      });
      connection.on('disconnect', params => {
        this.log.error('disconnect', params.err.stack);
        this.emitError('disconnected', params.err, urls);
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
    const opts = validate(op, joi.object().keys({
      name: joi.string().required(),
      json: joi.bool().default(true),
      setup: joi.func(),
    }));

    return new Promise((resolve, reject) => {
      const channel = this.client.createChannel(opts);
      const channelName = opts.name;
      channel.on('close', err => {
        this.log.error(`<${channelName}> channel :: closed`, err);
        if (err) {
          this.emitError('channel closed', err, {
            channelName,
          });
        }
        reject(err);
      });
      channel.on('error', err => {
        this.log.error(`<${channelName}> channel :: error`, err);
        if (err) {
          this.emitError('channel error', err, {
            channelName,
          });
        }
        reject(err);
      });
      channel.on('drop', message => {
        const error = new Error(`${channelName} channel :: dropped message`);
        this.log.error(error);
        this.emitError('message dropped', error, {
          channelName,
          droppedMessage: message,
        });
      });
      channel.on('connect', () => {
        const message = `<${channelName}> channel :: opened`;
        this.log.info(message);
        this.emitInfo('channel opened', message, {
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
  createQueue(queueName, op) {
    const opts = validate(op, joi.object().keys({
      durable: joi.bool().default(true),
      autoDelete: joi.bool().default(false),
    }));
    this.queues[queueName] = {};
    const self = this;
    return this.makeChannel({
      name: queueName,
      json: true,
      setup: function setup(ch) {
        ch.prefetch(1);
        // Create a queue
        return ch.assertQueue(queueName, opts).then(q => {
          const message = `"${queueName}" -> created ->` +
              ` ${q.consumerCount} consumers & ${q.messageCount} messages`;
          self.log.info(message);
          self.emitInfo('queue created', message, {
            queueName,
            consumerCount: q.consumerCount,
            messageCount: q.messageCount,
          });
          return this;
        });
      },
    }).then(channel => {
      this.queues[queueName].channel = channel;
    });
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
    return q.channel.addSetup(ch => {
      this.log.info('Subscribin to', qid);
      return ch.consume(qid, msg => {
        const message = {
          content: safeJSON(msg.content.toString()),
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
  unsubscribe(qName, tag) {
    const q = this.queues[qName];
    return q.channel._channel.cancel(tag);
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
  publish(qid, message, options, handle = true) {
    const q = this.queues[qid];
    const p = q.channel.sendToQueue(qid, message, options);
    if (handle === false) {
      return p;
    }
    return p
      .then(() => {
        this.log.info('Successfully published on', qid);
      })
      .catch((err) => {
        this.log.error(err);
        this.emitError('publishing', err, {
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
      this.log.info('Successfully published on', qname);
    }).catch(err => {
      this.log.error(err);
      this.emitError('sending', err, {
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
  getMessage(qname) {
    return this.channel._channel.get(qname, { noAck: true }).then(message => {
      if (message === false) {
        throw new Error(`No message on ${qname}`);
      }
      return JSON.parse(message.content.toString());
    });
  }
}

module.exports = Rabbit;
