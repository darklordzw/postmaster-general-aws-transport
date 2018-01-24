/* eslint import/no-unassigned-import: 'off' */
'use strict';

const chai = require('chai');
const dirtyChai = require('dirty-chai');
const errors = require('postmaster-general-core').errors;
const sinon = require('sinon');
const supertest = require('supertest');
const HTTPTransport = require('../index');
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

	afterEach(() => {
		sandbox.reset();
	});

	describe('constructor:', () => {
		it('should properly initialize settings from defaults', () => {
			const transport = new HTTPTransport();
			transport.port.should.equal(defaults.port);
			transport.serveGzip.should.equal(defaults.serveGzip);
			transport.sendGzip.should.equal(defaults.sendGzip);
		});
		it('should properly initialize settings from input', () => {
			const transport = new HTTPTransport({ port: 1500, sendGzip: false, serveGzip: false });
			transport.port.should.equal(1500);
			transport.serveGzip.should.be.false();
			transport.sendGzip.should.be.false();
		});
		it('should error on invalid input', () => {
			try {
				const transport = new HTTPTransport({ port: 'bob' }); // eslint-disable-line no-unused-vars
			} catch (err) {
				return;
			}
			throw new Error('Failed to catch invalid input.');
		});
	});

	describe('connect:', () => {
		it('should return a promise that resolves', () => {
			const transport = new HTTPTransport();
			return transport.connect();
		});
	});

	describe('disconnect:', () => {
		it('should return a promise that resolves', () => {
			const transport = new HTTPTransport();
			return transport.disconnect();
		});
		it('should cleanup resources', () => {
			const transport = new HTTPTransport();
			return transport.listen()
				.then(() => transport.disconnect())
				.then(() => {
					transport.listening.should.be.false();
					expect(transport.server).to.not.exist();
				});
		});
	});

	describe('resolveTopic:', () => {
		it('should catch invalid input', () => {
			try {
				const transport = new HTTPTransport();
				transport.resolveTopic(3353553);
			} catch (err) {
				return;
			}
			throw new Error('Failed to catch invalid input.');
		});
		it('should return the decoded input', () => {
			const transport = new HTTPTransport();
			const result = transport.resolveTopic('localhost:play_game');
			result.should.equal('localhost/play_game');
		});
	});

	describe('addListener:', () => {
		let transport;

		beforeEach(() => {
			transport = new HTTPTransport();
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.addListener('bob', (msg, correlationId, initiator) => {
				return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
			});
		});
		it('should catch invalid routingKey params', () => {
			return transport.addListener(44444, (msg, correlationId, initiator) => {
				return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
			})
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
			return transport.addListener('bob')
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
		it('should register a working get callback', () => {
			return transport.addListener('bob', (msg, correlationId, initiator) => {
				return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
			})
				.then((handler) => {
					expect(handler).to.exist();
				})
				.then(() => transport.listen())
				.then(() => supertest(transport.app)
					.get('/bob?testParam=5')
					.set('X-PMG-CorrelationId', 'testCorrelationId')
					.set('X-PMG-Initiator', 'testInitiator')
					.expect('Content-Type', /json/)
					.expect(200)
					.then((response) => { // eslint-disable-line max-nested-callbacks
						response.body.result.should.equal('Received {"testParam":"5"}, testCorrelationId, testInitiator');
					}));
		});
		it('should register a working post callback', () => {
			return transport.addListener('bob', (msg, correlationId, initiator) => {
				return Promise.resolve({ result: `Received ${JSON.stringify(msg)}, ${correlationId}, ${initiator}` });
			}, { httpMethod: 'POST' })
				.then((handler) => {
					expect(handler).to.exist();
				})
				.then(() => transport.listen())
				.then(() => supertest(transport.app)
					.post('/bob')
					.set('X-PMG-CorrelationId', 'testCorrelationId')
					.set('X-PMG-Initiator', 'testInitiator')
					.send({ postParam1: 'test value' })
					.expect('Content-Type', /json/)
					.expect(200)
					.then((response) => { // eslint-disable-line max-nested-callbacks
						response.body.result.should.equal('Received {"postParam1":"test value"}, testCorrelationId, testInitiator');
					}));
		});
		it('should handle unregistered routes appropriately', () => {
			return transport.listen()
				.then(() => supertest(transport.app)
					.post('/bob')
					.expect('Content-Type', /json/)
					.expect(404)
					.then((response) => { // eslint-disable-line max-nested-callbacks
						expect(response.body).to.exist();
						response.body.message.should.equal('Not Found');
					}));
		});
	});

	describe('removeListener:', () => {
		let transport;

		beforeEach(() => {
			transport = new HTTPTransport();
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.removeListener('bob');
		});
		it('should catch invalid routingKey params', () => {
			return transport.removeListener(35353535)
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
			return transport.addListener('bob', () => {
				return Promise.resolve();
			})
				.then((handler) => {
					expect(handler).to.exist();
				})
				.then(() => transport.listen())
				.then(() => supertest(transport.app)
					.get('/bob?testParam=5')
					.set('X-PMG-CorrelationId', 'testCorrelationId')
					.set('X-PMG-Initiator', 'testInitiator')
					.expect('Content-Type', /json/)
					.expect(200)
					.then((response) => { // eslint-disable-line max-nested-callbacks
						expect(response.body).to.exist();
					}))
				.then(() => transport.removeListener('bob'))
				.then(() => supertest(transport.app)
					.get('/bob?testParam=5')
					.set('X-PMG-CorrelationId', 'testCorrelationId')
					.set('X-PMG-Initiator', 'testInitiator')
					.expect('Content-Type', /json/)
					.expect(404));
		});
	});

	describe('listen:', () => {
		let transport;

		beforeEach(() => {
			transport = new HTTPTransport();
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.listen();
		});
		it('should start listening', () => {
			return transport.listen()
				.then(() => {
					transport.listening.should.be.true();
				})
				.then(() => supertest(transport.app)
					.get('/bob?testParam=5')
					.set('X-PMG-CorrelationId', 'testCorrelationId')
					.set('X-PMG-Initiator', 'testInitiator')
					.expect('Content-Type', /json/)
					.expect(404));
		});
	});

	describe('publish:', () => {
		let transport;
		let listenerTransport;

		beforeEach(() => {
			transport = new HTTPTransport();
			listenerTransport = new HTTPTransport();
			listenerTransport.addListener('bob', (msg) => {
				return Promise.resolve({ message: `${msg.message}, bob!` });
			});
			listenerTransport.listen();
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
			if (listenerTransport && listenerTransport.listening) {
				return listenerTransport.disconnect();
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
		let listenerTransport;

		beforeEach(() => {
			transport = new HTTPTransport();
			listenerTransport = new HTTPTransport();
			listenerTransport.addListener('bob', (msg) => {
				return Promise.resolve({ message: `${msg.message}, bob!` });
			})
			.then(() => listenerTransport.addListener('steve', (msg) => { // eslint-disable-line max-nested-callbacks
				if (!msg.message) {
					return Promise.reject(new errors.InvalidMessageError('Missing required parameter "message"'));
				}
				return Promise.resolve({ message: `${msg.message}, steve!` });
			}))
			.then(() => listenerTransport.addListener('dale', () => { // eslint-disable-line max-nested-callbacks
				return Promise.reject(new errors.ResponseProcessingError('Dale has an error!'));
			}))
			.then(() => listenerTransport.listen());
		});

		afterEach(() => {
			if (transport && transport.listening) {
				return transport.disconnect();
			}
			if (listenerTransport && listenerTransport.listening) {
				return listenerTransport.disconnect();
			}
		});

		it('should return a promise that resolves', () => {
			return transport.request('bob', { message: 'hello' }, { host: 'localhost', port: 3000 });
		});
		it('should catch invalid routingKey params', () => {
			return transport.request(35353535, { message: 'hello' }, { host: 'localhost', port: 3000 })
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
			return transport.request('bob', {}, { correlationId: 44444, host: 'localhost', port: 3000 })
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
			return transport.request('bob', {}, { initiator: 44444, host: 'localhost', port: 3000 })
				.then(() => {
					throw new Error('Failed to catch invalid input.');
				})
				.catch((err) => {
					if (!(err instanceof TypeError)) {
						throw err;
					}
				});
		});
		it('should resolve to the correct response', () => {
			return transport.request('bob', { message: 'hello' }, { host: 'localhost', port: 3000 })
				.then((response) => {
					expect(response).to.exist();
					expect(response.message).to.exist();
					response.message.should.equal('hello, bob!');
				});
		});
		it('should resolve to an invalid message error if the message is invalid', () => {
			return transport.request('steve', {}, { host: 'localhost', port: 3000 })
				.catch((err) => {
					if (!(err instanceof errors.InvalidMessageError)) {
						throw err;
					}
				});
		});
		it('should resolve to a general processing error if a general error occurs', () => {
			return transport.request('dale', {}, { host: 'localhost', port: 3000 })
				.catch((err) => {
					if (!(err instanceof errors.ResponseProcessingError)) {
						throw err;
					}
				});
		});
	});
});
