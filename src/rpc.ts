
import { v4 as uuid } from 'uuid';
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
class RPC {
  name: string;
  emitter: events.EventEmitter;
  config: RPCConfig;
  rabbit: Rabbit;
  requestQ: ChannelWrapper;
  replyQ: ChannelWrapper;
  callbacks: {[_: string]: (value: unknown) => any };
  /**
   * @param {string} name - unique name to this service
   * @param {EventEmitter} emitter
   * @param {Object} config - configuration object of service
   */
  constructor(name, emitter, config, rabbit: Rabbit) {
    this.name = name;
    this.emitter = emitter;
    this.config = config;
    this.rabbit = rabbit;
    this.requestQ = null;
    this.replyQ = null;
    this.callbacks = {};
  }

  log(message: string, data?: Record<string, unknown>) {
    this.emitter.emit('log', {
      service: this.name,
      message,
      data,
    });
  }

  success(message: string, data?: Record<string, unknown>) {
    this.emitter.emit('success', {
      service: this.name, message, data,
    });
  }

  error(err: Error, data?: Record<string, unknown>) {
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
  async init() {
    const { request, reply } = this.config;
    const [requestQ, replyQ] = await Promise.all([
      this.rabbit.createQueue(request),
      this.rabbit.createQueue(reply, {
        autoDelete: false,
      }),
    ]);
    this.requestQ = requestQ;
    this.replyQ = replyQ;
    // subscribe to this queue
    return this.subscribe(reply);
  }


  /**
   * Make a request in rpc system with given name
   *
   * @param {string} name
   * @param {Object} message
   *
   * @param {Promise}
   */
  request(message: Record<string, unknown>) {
    return new Promise((resolve) => { // eslint-disable-line
      const { request, reply } = this.config;
      const correlationId = uuid();
      // register your callback
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
  subscribe(qname: string) {
    return this.rabbit.subscribe(qname, (msg) => {
      msg.ack();
      const correlationId = msg.correlationId;
      // get the callback
      const cb = this.callbacks[correlationId];
      if (!cb) {
        const error = new Error(`Callback not present for ${correlationId}`);
        this.error(error, {
          correlationId,
        });
        return true;
      }
      // call the callback
      cb(msg.content);
      // delete the callback associted with this correlationId
      delete this.callbacks[correlationId];
    });
  }
}

export = RPC;
