/* eslint import/no-unassigned-import: 'off' */
'use strict';

const chai = require('chai');
const dirtyChai = require('dirty-chai');
const errors = require('postmaster-general-core').errors;
const sinon = require('sinon');
const AWS = require('aws-sdk-mock');
const AWSTransport = require('../index');
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
		AWS.mock('SQS', 'createQueue', (params, callback) => {
			callback(null, { QueueUrl: `${params.QueueName}-queue-url` });
		});
		AWS.mock('SQS', 'getQueueAttributes', (params, callback) => {
			callback(null, { QueueArn: `${params.QueueUrl}-queue-arn` });
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
		AWS.mock('SNS', 'subscribe', (params, callback) => {
			callback(null, { SubscriptionArn: `${params.TopicArn}-subscription-arn` });
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

	// describe('addListener:', () => {
	// 	let transport;

	// 	beforeEach(() => {
	// 		transport = new AWSTransport({ queue: 'bob' });
	// 	});

	// 	afterEach(() => {
	// 		if (transport && transport.listening) {
	// 			return transport.disconnect();
	// 		}
	// 	});

	// 	it('should return a promise that resolves', () => {
	// 		return transport.addListener('bobMessage', (msg, correlationId, initiator) => {
	// 			return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
	// 		});
	// 	});
	// 	it('should catch invalid routingKey params', () => {
	// 		return transport.addListener(44444, (msg, correlationId, initiator) => {
	// 			return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
	// 		})
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should catch invalid callback params', () => {
	// 		return transport.addListener('bob')
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should register a working get callback', () => {
	// 		return transport.addListener('bob', (msg, correlationId, initiator) => {
	// 			return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
	// 		})
	// 			.then((handler) => {
	// 				expect(handler).to.exist();
	// 			})
	// 			.then(() => transport.listen())
	// 			.then(() => supertest(transport.app)
	// 				.get('/bob?testParam=5')
	// 				.set('X-PMG-CorrelationId', 'testCorrelationId')
	// 				.set('X-PMG-Initiator', 'testInitiator')
	// 				.expect('Content-Type', /json/)
	// 				.expect(200)
	// 				.then((response) => { // eslint-disable-line max-nested-callbacks
	// 					response.body.result.should.equal('Received {"testParam":"5"}, testCorrelationId, testInitiator');
	// 				}));
	// 	});
	// 	it('should register a working post callback', () => {
	// 		return transport.addListener('bob', (msg, correlationId, initiator) => {
	// 			return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
	// 		}, { httpMethod: 'POST' })
	// 			.then((handler) => {
	// 				expect(handler).to.exist();
	// 			})
	// 			.then(() => transport.listen())
	// 			.then(() => supertest(transport.app)
	// 				.post('/bob')
	// 				.set('X-PMG-CorrelationId', 'testCorrelationId')
	// 				.set('X-PMG-Initiator', 'testInitiator')
	// 				.send({ postParam1: 'test value' })
	// 				.expect('Content-Type', /json/)
	// 				.expect(200)
	// 				.then((response) => { // eslint-disable-line max-nested-callbacks
	// 					response.body.result.should.equal('Received {"postParam1":"test value"}, testCorrelationId, testInitiator');
	// 				}));
	// 	});
	// 	it('should handle unregistered routes appropriately', () => {
	// 		return transport.listen()
	// 			.then(() => supertest(transport.app)
	// 				.post('/bob')
	// 				.expect('Content-Type', /json/)
	// 				.expect(404)
	// 				.then((response) => { // eslint-disable-line max-nested-callbacks
	// 					expect(response.body).to.exist();
	// 					response.body.message.should.equal('Not Found');
	// 				}));
	// 	});
	// });

	// describe('removeListener:', () => {
	// 	let transport;

	// 	beforeEach(() => {
	// 		transport = new AWSTransport();
	// 	});

	// 	afterEach(() => {
	// 		if (transport && transport.listening) {
	// 			return transport.disconnect();
	// 		}
	// 	});

	// 	it('should return a promise that resolves', () => {
	// 		return transport.removeListener('bob');
	// 	});
	// 	it('should catch invalid routingKey params', () => {
	// 		return transport.removeListener(35353535)
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should remove the listener', () => {
	// 		return transport.addListener('bob', () => {
	// 			return Promise.resolve();
	// 		})
	// 			.then((handler) => {
	// 				expect(handler).to.exist();
	// 			})
	// 			.then(() => transport.listen())
	// 			.then(() => supertest(transport.app)
	// 				.get('/bob?testParam=5')
	// 				.set('X-PMG-CorrelationId', 'testCorrelationId')
	// 				.set('X-PMG-Initiator', 'testInitiator')
	// 				.expect('Content-Type', /json/)
	// 				.expect(200)
	// 				.then((response) => { // eslint-disable-line max-nested-callbacks
	// 					expect(response.body).to.exist();
	// 				}))
	// 			.then(() => transport.removeListener('bob'))
	// 			.then(() => supertest(transport.app)
	// 				.get('/bob?testParam=5')
	// 				.set('X-PMG-CorrelationId', 'testCorrelationId')
	// 				.set('X-PMG-Initiator', 'testInitiator')
	// 				.expect('Content-Type', /json/)
	// 				.expect(404));
	// 	});
	// });

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

	// describe('publish:', () => {
	// 	let transport;
	// 	let listenerTransport;

	// 	beforeEach(() => {
	// 		transport = new AWSTransport();
	// 		listenerTransport = new AWSTransport();
	// 		listenerTransport.addListener('bob', (msg) => {
	// 			return Promise.resolve({ message: `${msg.message}, bob!` });
	// 		});
	// 		listenerTransport.listen();
	// 	});

	// 	afterEach(() => {
	// 		if (transport && transport.listening) {
	// 			return transport.disconnect();
	// 		}
	// 		if (listenerTransport && listenerTransport.listening) {
	// 			return listenerTransport.disconnect();
	// 		}
	// 	});

	// 	it('should return a promise that resolves', () => {
	// 		return transport.publish('bob', { message: 'hello' }, { host: 'localhost', port: 3000 });
	// 	});
	// 	it('should catch invalid routingKey params', () => {
	// 		return transport.publish(35353535, { message: 'hello' }, { host: 'localhost', port: 3000 })
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should catch invalid correlationId params', () => {
	// 		return transport.publish('bob', {}, { correlationId: 44444, host: 'localhost', port: 3000 })
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should catch invalid initiator params', () => {
	// 		return transport.publish('bob', {}, { initiator: 44444, host: 'localhost', port: 3000 })
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// });

	// describe('request:', () => {
	// 	let transport;
	// 	let listenerTransport;

	// 	beforeEach(() => {
	// 		transport = new AWSTransport();
	// 		listenerTransport = new AWSTransport();
	// 		listenerTransport.addListener('bob', (msg) => {
	// 			return Promise.resolve({ message: `${msg.message}, bob!` });
	// 		})
	// 		.then(() => listenerTransport.addListener('steve', (msg) => { // eslint-disable-line max-nested-callbacks
	// 			if (!msg.message) {
	// 				return Promise.reject(new errors.InvalidMessageError('Missing required parameter "message"'));
	// 			}
	// 			return Promise.resolve({ message: `${msg.message}, steve!` });
	// 		}))
	// 		.then(() => listenerTransport.addListener('dale', () => { // eslint-disable-line max-nested-callbacks
	// 			return Promise.reject(new errors.ResponseProcessingError('Dale has an error!'));
	// 		}))
	// 		.then(() => listenerTransport.listen());
	// 	});

	// 	afterEach(() => {
	// 		if (transport && transport.listening) {
	// 			return transport.disconnect();
	// 		}
	// 		if (listenerTransport && listenerTransport.listening) {
	// 			return listenerTransport.disconnect();
	// 		}
	// 	});

	// 	it('should return a promise that resolves', () => {
	// 		return transport.request('bob', { message: 'hello' }, { host: 'localhost', port: 3000 });
	// 	});
	// 	it('should catch invalid routingKey params', () => {
	// 		return transport.request(35353535, { message: 'hello' }, { host: 'localhost', port: 3000 })
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should catch invalid correlationId params', () => {
	// 		return transport.request('bob', {}, { correlationId: 44444, host: 'localhost', port: 3000 })
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should catch invalid initiator params', () => {
	// 		return transport.request('bob', {}, { initiator: 44444, host: 'localhost', port: 3000 })
	// 			.then(() => {
	// 				throw new Error('Failed to catch invalid input.');
	// 			})
	// 			.catch((err) => {
	// 				if (!(err instanceof TypeError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should resolve to the correct response', () => {
	// 		return transport.request('bob', { message: 'hello' }, { host: 'localhost', port: 3000 })
	// 			.then((response) => {
	// 				expect(response).to.exist();
	// 				expect(response.message).to.exist();
	// 				response.message.should.equal('hello, bob!');
	// 			});
	// 	});
	// 	it('should resolve to an invalid message error if the message is invalid', () => {
	// 		return transport.request('steve', {}, { host: 'localhost', port: 3000 })
	// 			.catch((err) => {
	// 				if (!(err instanceof errors.InvalidMessageError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// 	it('should resolve to a general processing error if a general error occurs', () => {
	// 		return transport.request('dale', {}, { host: 'localhost', port: 3000 })
	// 			.catch((err) => {
	// 				if (!(err instanceof errors.ResponseProcessingError)) {
	// 					throw err;
	// 				}
	// 			});
	// 	});
	// });
});
