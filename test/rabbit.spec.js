/* eslint no-console:0 */

const hold = require('hold-it');
const EventEmitter = require('events').EventEmitter;

const { Rabbit } = require('../src/index');

const emitter = new EventEmitter();
emitter.on('error', console.error.bind(console));
emitter.on('success', console.log.bind(console));
emitter.on('info', console.log.bind(console));

describe('Rabbit', function () {
  it('should connect to default config', async function () {
    const rabbit = new Rabbit('default', emitter, {
      user: 'guest',
      password: 'guest',
    });
    await rabbit.init();
    hold.add('rabbit', rabbit);
  });

  it('should create a queue', async function () {
    await hold.get('rabbit').createQueue('test');
  });

  it('should publish message on queue', async function () {
    await hold.get('rabbit').publish('test', { mesasge: 'test' });
  });

  it('should add subscription on the queue', function (done) {
    hold.get('rabbit').subscribe('test', (m) => {
      m.ack();
      done();
    })
      .then((data) => {
        hold.add('tag', data.consumerTag);
      })
      .catch(done);
  });

  it('should empty the queue', async function () {
    await hold.get('rabbit').channel._channel.purgeQueue('test');
  });

  it('should remove the subsctiption', async function () {
    await hold.get('rabbit').unsubscribe('test', hold.get('tag'));
  });

  it('should just send the message', async function () {
    await hold.get('rabbit').send('test', { mesasge: 'send' });
  });

  it('should get the message', async function () {
    const result = await hold.get('rabbit').getMessage('test');
    return result;
  });
});
