/* eslint import/no-unassigned-import: 'off' */
'use strict';

const chai = require('chai');
const dirtyChai = require('dirty-chai');
const errors = require('postmaster-general-core').errors;
const Promise = require('bluebird');
const sinon = require('sinon');
const AWS = require('aws-sdk-mock');
const AWSTransport = require('..');
const defaults = require('../defaults.json');

/* This sets up the Chai assertion library. "should" and "expect"
initialize their respective assertion properties. The "use()" functions
load plugins into Chai. "dirtyChai" just allows assertion properties to
use function call syntax ("calledOnce()" vs "calledOnce"). It makes them more
acceptable to the linter. */
const expect = chai.expect;
chai.should();
chai.use(dirtyChai);

describe('aws-transport:', () => {
	let sandbox;

	before(() => {
		sandbox = sinon.createSandbox();
	});

	beforeEach(() => {
		// Go ahead and provide a basic "success" mock for each of the AWS functions we'll be calling.
		AWS.mock('SQS', 'createQueue', (params, callback) => {
			callback(null, { QueueUrl: `${params.QueueName}-queue-url` });
		});
		AWS.mock('SQS', 'getQueueAttributes', (params, callback) => {
			callback(null, {
				QueueArn: `${params.QueueUrl}-queue-arn`,
				Policy: JSON.stringify({
					Version: '2012-10-17',
					Id: `${this.queueArn}/SQSDefaultPolicy`,
					Statement: []
				})
			});
		});
		AWS.mock('SQS', 'setQueueAttributes', (params, callback) => {
			callback(null);
		});
		AWS.mock('SQS', 'receiveMessage', (params, callback) => {
			setTimeout(() => {
				callback(null, { Messages: [] });
			}, params.WaitTimeSeconds);
		});
		AWS.mock('SQS', 'deleteMessage', (params, callback) => {
			callback();
		});
		AWS.mock('SNS', 'createTopic', (params, callback) => {
			callback(null, { TopicArn: `${params.Name}-topic-arn` });
		});
		AWS.mock('SNS', 'publish', (params, callback) => {
			callback(null, { MessageId: 1 });
		});
		AWS.mock('SNS', 'subscribe', (params, callback) => {
			callback(null, { SubscriptionArn: `${params.TopicArn}-subscription-arn` });
		});
		AWS.mock('SNS', 'listSubscriptionsByTopic', (params, callback) => {
			callback(null, { Subscriptions: [] });
		});
	});

	afterEach(() => {
		sandbox.reset();
		AWS.restore();
	});

	describe('constructor:', () => {
		it('should properly initialize settings from defaults', () => {
			const transport = new AWSTransport();
			expect(transport.queue).to.not.exist();
			expect(transport.accessKeyId).to.not.exist();
			expect(transport.secretAccessKey).to.not.exist();
			transport.region.should.equal(defaults.region);
			transport.batchSize.should.equal(defaults.batchSize);
			transport.visibilityTimeout.should.equal(defaults.visibilityTimeout.toString());
			transport.maxReceiveCount.should.equal(defaults.maxReceiveCount);
			expect(transport.deadLetterQueueArn).to.not.exist();
		});
		it('should properly initialize settings from input', () => {
			const transport = new AWSTransport({
				queue: 'bob',
				accessKeyId: 'bobKey',
				secretAccessKey: 'bobSecret',
				region: 'bobRegion',
				batchSize: 10,
				visibilityTimeout: 15,
				maxReceiveCount: 11,
				deadLetterQueueArn: 'bobdlq'
			});
			transport.queue.should.equal('bob');
			transport.accessKeyId.should.equal('bobKey');
			transport.secretAccessKey.should.equal('bobSecret');
			transport.region.should.equal('bobRegion');
			transport.batchSize.should.equal(10);
			transport.visibilityTimeout.should.equal('15');
			transport.maxReceiveCount.should.equal(11);
			transport.deadLetterQueueArn.should.equal('bobdlq');
		});
		it('should error on invalid input', () => {
			try {
				const transport = new AWSTransport({ queue: false }); // eslint-disable-line no-unused-vars
			} catch (err) {
				return;
			}
			throw new Error('Failed to catch invalid input.');
		});
	});

	describe('connect:', () => {
		it('should return a promise that resolves', () => {
			const transport = new AWSTransport();
			return transport.connect()
				.then(() => {
					expect(transport.queueArn).to.not.exist();
					expect(transport.queueUrl).to.not.exist();
				});
		});
		it('should create an SQS queue if one is specified', () => {
			const transport = new AWSTransport({ queue: 'bob' });
			return transport.connect()
				.then(() => {
					transport.queueArn.should.equal('bob-queue-url-queue-arn');
					transport.queueUrl.should.equal('bob-queue-url');
				});
		});
		it('should create an SQS queue with the correct parameters', () => {
			AWS.restore('SQS', 'createQueue');
			AWS.mock('SQS', 'createQueue', (params, callback) => {
				if (params.QueueName === 'bob' &&
					params.Attributes.VisibilityTimeout === '30' &&
					params.Attributes.RedrivePolicy === '{"deadLetterTargetArn":"bobdlq","maxReceiveCount":5}') {
					callback(null, { QueueUrl: 'true' });
				} else {
					callback(null, { QueueUrl: 'false' });
				}
			});

			const transport = new AWSTransport({ queue: 'bob', deadLetterQueueArn: 'bobdlq' });
			return transport.connect()
				.then(() => {
					transport.queueArn.should.equal('true-queue-arn');
					transport.queueUrl.should.equal('true');
				});
		});
	});

	describe('disconnect:', () => {
		it('should return a promise that resolves', () => {
			const transport = new AWSTransport();
			return transport.disconnect();
		});
		it('should cleanup resources', () => {
			const transport = new AWSTransport({ queue: 'bob' });
			return transport.connect()
				.then(() => transport.listen())
				.then(() => {
					return transport.disconnect();
				})
				.then(() => {
					transport.listening.should.be.false();
					expect(transport.consumer).to.exist();
					transport.consumer.stopped.should.be.true();
				});
		});
	});

	describe('resolveTopic:', () => {
		it('should catch invalid input', () => {
			try {
				const transport = new AWSTransport();
				transport.resolveTopic(3353553);
			} catch (err) {
				return;
			}
			throw new Error('Failed to catch invalid input.');
		});
		it('should return the decoded input', () => {
			const transport = new AWSTransport();
			const result = transport.resolveTopic('localhost:play_game');
			result.should.equal('localhost-play_game');
		});
	});

	describe('addMessageListener:', () => {
		let transport;

		beforeEach(() => {
			transport = new AWSTransport({ queue: 'bob' });
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.connect()
				.then(() => transport.addMessageListener('bobMessage', (msg, correlationId, initiator) => { // eslint-disable-line max-nested-callbacks
					return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
				}));
		});
		it('should catch invalid routingKey params', () => {
			return transport.connect()
				.then(() => transport.addMessageListener(44444, (msg, correlationId, initiator) => { // eslint-disable-line max-nested-callbacks
					return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
				}))
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
		it('should catch invalid callback params', () => {
			return transport.connect()
				.then(() => transport.addMessageListener('bobMessage'))
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
		it('should register a working get callback', (done) => {
			AWS.restore('SQS', 'receiveMessage');
			AWS.mock('SQS', 'receiveMessage', (params, callback) => {
				setTimeout(() => { // eslint-disable-line max-nested-callbacks
					callback(null, {
						Messages: [
							{
								ReceiptHandle: 'test',
								MessageId: 1,
								Body: JSON.stringify({ Message: JSON.stringify({ testMessage: 'test value' }) }),
								MessageAttributes: {
									correlationId: { StringValue: 'test' },
									initiator: { StringValue: 'test' },
									topic: { StringValue: 'bobMessage' }
								}
							}
						]
					});
				}, 1000);
			});

			transport.connect()
				.then(() => transport.addMessageListener('bobMessage', (msg, correlationId, initiator) => { // eslint-disable-line max-nested-callbacks
					try {
						msg.testMessage.should.equal('test value');
						correlationId.should.equal('test');
						initiator.should.equal('test');
						done();
					} catch (err) {
						done(err);
					}
					return Promise.resolve(this);
				}))
				.then((handler) => {
					expect(handler).to.exist();
				})
				.then(() => transport.listen())
				.catch((err) => {
					done(err);
				});
		});
	});

	describe('removeMessageListener:', () => {
		let transport;

		beforeEach(() => {
			transport = new AWSTransport({ queue: 'bob' });
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.removeMessageListener('bobMessage');
		});
		it('should catch invalid routingKey params', () => {
			return transport.removeMessageListener(35353535)
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
		it('should remove the listener', () => {
			return transport.connect()
				.then(() => transport.addMessageListener('bobMessage', () => { // eslint-disable-line max-nested-callbacks
					return Promise.resolve();
				}))
				.then(() => transport.listen())
				.then(() => {
					expect(transport.handlers.bobMessage).to.exist();
				})
				.then(() => transport.removeMessageListener('bobMessage'))
				.then(() => {
					expect(transport.handlers.bobMessage).to.not.exist();
				});
		});
	});

	describe('listen:', () => {
		let transport;

		beforeEach(() => {
			transport = new AWSTransport({ queue: 'bob' });
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.connect()
				.then(() => transport.listen());
		});
		it('should start listening', () => {
			return transport.connect()
				.then(() => transport.listen())
				.then(() => {
					transport.listening.should.be.true();
					expect(transport.consumer).to.exist();
					transport.consumer.stopped = false;
				});
		});
	});

	describe('publish:', () => {
		let transport;

		beforeEach(() => {
			transport = new AWSTransport();
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.publish('bob', { message: 'hello' }, { host: 'localhost', port: 3000 });
		});
		it('should catch invalid routingKey params', () => {
			return transport.publish(35353535, { message: 'hello' }, { host: 'localhost', port: 3000 })
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
		it('should catch invalid correlationId params', () => {
			return transport.publish('bob', {}, { correlationId: 44444, host: 'localhost', port: 3000 })
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
		it('should catch invalid initiator params', () => {
			return transport.publish('bob', {}, { initiator: 44444, host: 'localhost', port: 3000 })
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
	});

	describe('request:', () => {
		let transport;

		beforeEach(() => {
			transport = new AWSTransport({ queue: 'bob' });
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should reject with a NotImplementedException', (done) => {
			transport.request('bob', { message: 'hello' }, { host: 'localhost', port: 3000 })
				.then(() => {
					done(new Error('Failed to catch error'));
				})
				.catch((err) => {
					try {
						expect(err instanceof errors.NotImplementedError).to.be.true();
						done();
					} catch (err) {
						done(err);
					}
				});
		});
	});
});
