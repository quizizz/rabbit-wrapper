
const uuid = require('uuid/v4');

const { is } = require('@akshendra/misc');
const Service = require('@akshendra/service');
const { validate, joi } = require('@akshendra/validator');

/**
 * @class RRPC
 */
class RRPC extends Service {
  /**
   * @param {string} name - unique name to this service
   * @param {EventEmitter} emitter
   * @param {Object} config - configuration object of service
   */
  constructor(name, emitter, config, rabbit) {
    super(name, emitter, config);

    this.config = validate(config, joi.object().keys({
      request: joi.string().required(),
      reply: joi.string().required(),
    }));

    this.rabbit = rabbit;
    this.requestQ = null;
    this.replyQ = null;
    this.callbacks = {};
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
      if (is.not.existy(cb)) {
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
