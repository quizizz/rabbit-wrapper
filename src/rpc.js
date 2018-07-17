
const uuid = require('uuid/v4');

/**
 * @class RRPC
 */
class RRPC {
  /**
   * @param {string} name - unique name to this service
   * @param {EventEmitter} emitter
   * @param {Object} config - configuration object of service
   */
  constructor(name, emitter, config, rabbit) {
    this.name = name;
    this.emitter = emitter;

    this.config = config;

    this.rabbit = rabbit;
    this.requestQ = null;
    this.replyQ = null;
    this.callbacks = {};
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
   * Initialize this rpc
   *
   * @return {Promise<this>}
   */
  init() {
    const { request, reply } = this.config;

    return Promise.all([
      this.rabbit.createQueue(request),
      this.rabbit.createQueue(reply, {
        autoDelete: true,
      }),
    ]).then(([requestQ, replyQ]) => {
      this.requestQ = requestQ;
      this.replyQ = replyQ;

      // subscribe to this queue
      return this.subscribe(reply);
    });
  }


  /**
   * Make a request in rpc system with given name
   *
   * @param {string} name
   * @param {Object} message
   *
   * @param {Promise}
   */
  request(message) {
    return new Promise((resolve) => { // eslint-disable-line
      const { request, reply } = this.config;
      const correlationId = uuid();
      // register you callback
      this.callbacks[correlationId] = resolve;
      this.rabbit.publish(request, message, {
        correlationId,
        replyTo: reply,
      });
    });
  }


  /**
   * subscribe to the queue and also call the associated callback when needed
   *
   * @param {string} qname
   */
  subscribe(qname) {
    return this.rabbit.subscribe(qname, (msg) => {
      msg.ack();
      const correlationId = msg.correlationId;
      // get the callback
      const cb = this.callbacks[correlationId];
      if (!cb) {
        const error = new Error(`Callback not present for ${correlationId}`);
        this.log.error(error);
        this.emitError('wait', error, {
          correlationId,
        });
      }
      // call the callback
      cb(msg.content);
      // delete the callback associted with this correlationId
      delete this.callbacks[correlationId];
    });
  }
}

module.exports = RRPC;
