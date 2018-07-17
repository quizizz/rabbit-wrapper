
const amqp = require('amqp-connection-manager');
const safeJSON = require('safely-parse-json');

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

    this.config = Object.assign({
      hosts: ['localhost'],
      port: 5672,
    }, config, {
      opts: Object.assign({
        heartbeatIntervalInSeconds: 5,
        reconnectTimeInSeconds: 2,
      }, config.opts),
    });

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
      `${config.port}`
    ));
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
      const connection = amqp.connect(urls, opts);
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
    const opts = Object.assign({
      json: true,
    }, op);

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
  createQueue(queueName, op) {
    const opts = Object.assign({
      durable: true,
      autoDelete: false,
    }, op);
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
          self.log(message, {
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
      this.log(`Subscribin to ${qid}`);
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
      })
      .catch((err) => {
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
  getMessage(qname) {
    return this.channel._channel.get(qname, { noAck: true }).then(message => {
      if (message === false) {
        throw new Error(`No message on ${qname}`);
      }
      return safeJSON(message.content.toString());
    });
  }
}

module.exports = Rabbit;
