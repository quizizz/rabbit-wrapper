"use strict";
const uuid_1 = require("uuid");
/**
 * @class RRPC
 */
class RPC {
    name;
    emitter;
    config;
    rabbit;
    requestQ;
    replyQ;
    callbacks;
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
    request(message) {
        return new Promise((resolve) => {
            const { request, reply } = this.config;
            const correlationId = uuid_1.v4();
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
    subscribe(qname) {
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
module.exports = RPC;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnBjLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3JwYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQ0EsK0JBQWtDO0FBV2xDOztHQUVHO0FBQ0gsTUFBTSxHQUFHO0lBQ1AsSUFBSSxDQUFTO0lBQ2IsT0FBTyxDQUFzQjtJQUM3QixNQUFNLENBQVk7SUFDbEIsTUFBTSxDQUFTO0lBQ2YsUUFBUSxDQUFpQjtJQUN6QixNQUFNLENBQWlCO0lBQ3ZCLFNBQVMsQ0FBMEM7SUFDbkQ7Ozs7T0FJRztJQUNILFlBQVksSUFBSSxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBYztRQUMvQyxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztRQUNqQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztRQUN2QixJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQztRQUNyQixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztRQUNuQixJQUFJLENBQUMsU0FBUyxHQUFHLEVBQUUsQ0FBQztJQUN0QixDQUFDO0lBRUQsR0FBRyxDQUFDLE9BQWUsRUFBRSxJQUE4QjtRQUNqRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUU7WUFDdkIsT0FBTyxFQUFFLElBQUksQ0FBQyxJQUFJO1lBQ2xCLE9BQU87WUFDUCxJQUFJO1NBQ0wsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELE9BQU8sQ0FBQyxPQUFlLEVBQUUsSUFBOEI7UUFDckQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFO1lBQzNCLE9BQU8sRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxJQUFJO1NBQ2xDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxLQUFLLENBQUMsR0FBVSxF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