'use strict';

/**
 * A transport module for postmaster-general using AWS SNS and SQS.
 * @module index
 */

const _ = require('lodash');
const AWS = require('aws-sdk');
const Consumer = require('sqs-consumer');
const errors = require('postmaster-general-core').errors;
const Transport = require('postmaster-general-core').Transport;
const defaults = require('./defaults');

/**
 * A postmaster-general transport module using AWS SNS and SQS.
 * @extends Transport
 */
class AWSTransport extends Transport {
	/**
	 * Constructor for the AWSTransport object.
	 * @param {object} [options] - Optional settings.
	 * @param {number} [options.timingsResetInterval] - How frequently should the transport clear its timing metrics, in milliseconds.
	 * @param {string} [options.queue] - The name of the SQS queue to listen to.
	 * @param {string} [options.accessKeyId] - The AWS access key id to authenticate with. Defaults to the value of process.env.AWS_ACCESS_KEY_ID if not passed.
	 * @param {string} [options.secretAccessKey] - The AWS secret access key to authenticate with. Defaults to the value of process.env.AWS_SECRET_ACCESS_KEY if not passed.
	 * @param {string} [options.region] - The AWS region.
	 * @param {number} [options.batchSize] - The number of messages to request from SQS when polling. This cannot be higher than the AWS limit of 10.
	 * @param {number} [options.visibilityTimeout] - The duration (in seconds) that the received messages are hidden from subsequent retrieve requests after being retrieved.
	 * @param {number} [options.maxReceiveCount] - The maximum number of times to requeue a message before it's sent to the dead letter queue.
	 * @param {string} [options.deadLetterQueueArn] - The Arn of the dead letter queue to send dead messages to.
	 */
	constructor(options) {
		super(options);
		options = options || {};

		if (!_.isUndefined(options.queue) && !_.isString(options.queue)) {
			throw new TypeError('"options.queue" should be a string.');
		}
		if (!_.isUndefined(options.accessKeyId) && !_.isString(options.accessKeyId)) {
			throw new TypeError('"options.accessKeyId" should be a string.');
		}
		if (!_.isUndefined(options.secretAccessKey) && !_.isString(options.secretAccessKey)) {
			throw new TypeError('"options.secretAccessKey" should be a string.');
		}
		if (!_.isUndefined(options.region) && !_.isString(options.region)) {
			throw new TypeError('"options.region" should be a string.');
		}
		if (!_.isUndefined(options.batchSize) && !_.isNumber(options.batchSize)) {
			throw new TypeError('"options.batchSize" should be a number.');
		}
		if (!_.isUndefined(options.visibilityTimeout) && !_.isNumber(options.visibilityTimeout)) {
			throw new TypeError('"options.visibilityTimeout" should be a number.');
		}
		if (!_.isUndefined(options.maxReceiveCount) && !_.isNumber(options.maxReceiveCount)) {
			throw new TypeError('"options.maxReceiveCount" should be a number.');
		}
		if (!_.isUndefined(options.deadLetterQueueArn) && !_.isString(options.deadLetterQueueArn)) {
			throw new TypeError('"options.deadLetterQueueArn" should be a string.');
		}

		this.queue = options.queue;
		this.queueUrl = null;
		this.queueArn = null;
		this.accessKeyId = options.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
		this.secretAccessKey = options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
		this.region = options.region || defaults.region;
		this.batchSize = options.batchSize || defaults.batchSize;
		this.visibilityTimeout = (options.visibilityTimeout || defaults.visibilityTimeout).toString();
		this.maxReceiveCount = options.maxReceiveCount || defaults.maxReceiveCount;
		this.deadLetterQueueArn = options.deadLetterQueueArn;
		this.handlers = {};
		this.registeredTopics = {
			publish: new Set(),
			subscribe: new Set()
		};
		this.consumer = null;

		// Go ahead and initialize AWS here so it's available wherever we need it.
		AWS.config.update({
			region: this.region,
			accessKeyId: this.accessKeyId,
			secretAccessKey: this.secretAccessKey
		});

		this.sqs = new AWS.SQS();
		this.sns = new AWS.SNS();
	}

	/**
	 * Connects the transport from to any services it needs to function.
	 * In this case, it creates the SQS queue to consume from, if a queue name was specified
	 * in the constructor. The creation call is only made once during the lifetime of the transport
	 * to save on AWS calls.
	 * @returns {Promise}
	 */
	connect() {
		return super.connect()
			.then(() => {
				// Only try creation if we have a queue to create and we haven't already created it.
				if (this.queue && (!this.queueUrl || !this.queueArn)) {
					const queueOptions = {
						QueueName: this.queue,
						Attributes: {
							VisibilityTimeout: this.visibilityTimeout
						}
					};

					if (this.deadLetterQueueArn) {
						queueOptions.Attributes.RedrivePolicy = JSON.stringify({
							deadLetterTargetArn: this.deadLetterQueueArn,
							maxReceiveCount: this.maxReceiveCount
						});
					}

					return this.sqs.createQueue(queueOptions).promise()
						.then((data) => {
							this.queueUrl = data.QueueUrl;
							return this.sqs.getQueueAttributes({ QueueUrl: data.QueueUrl, AttributeNames: ['QueueArn'] }).promise();
						})
						.then((data) => {
							this.queueArn = data.QueueArn;
						});
				}
			});
	}

	/**
	 * Disconnects the transport from any services it references.
	 * In this case, it simply stops the SQS consumer.
	 * @returns {Promise}
	 */
	disconnect() {
		return super.disconnect()
			.then(() => {
				if (this.consumer) {
					this.consumer.stop();
				}
			});
	}

	/**
	 * Processes a routing key into a format appropriate for the transport type.
	 * @param {string} routingKey - The routing key to convert.
	 * @returns {string}
	 */
	resolveTopic(routingKey) {
		return super.resolveTopic(routingKey).replace(/:/g, '-');
	}

	/**
	 * Adds a new message handler. This is done by creating an SNS topic and subscribing the
	 * queue to the topic. Asserting the topic and the subscription is only done once
	 * during the lifetime of the transport to save on AWS calls.
	 * @param {string} routingKey - The routing key of the message to handle.
	 * @param {function} callback - The function to call when a new message is received.
	 * @param {object} [options] - Optional params for configuring the handler.
	 * @returns {Promise}
	 */
	addListener(routingKey, callback, options) {
		return super.addListener(routingKey, callback, options)
			.then((callbackWrapper) => {
				if (!this.queueUrl || !this.queueArn) {
					throw new Error('Unable to add listener, "connect()" should be called first.');
				}

				const topic = this.resolveTopic(routingKey);
				this.handlers[topic] = callbackWrapper;

				if (!this.registeredTopics.subscribe.has(topic)) {
					return this.sns.createTopic({ Name: topic }).promise()
						.then((data) => this.sns.subscribe({ Protocol: 'sqs', TopicArn: data.TopicArn, Endpoint: this.queueArn }).promise())
						.then((data) => {
							if (!data.SubscriptionArn) {
								throw new Error(`Unable to create a subscription from topic ${topic} to SQS queue ${this.queueUrl}`);
							}
							return this.handlers[topic];
						});
				}

				return this.handlers[topic];
			});
	}

	/**
	 * Deletes a message handler. Note that this does not cleanup any SQS queues or topics
	 * associated with this transport, as they may be shared among multiple services.
	 * @param {string} routingKey - The routing key of the handler to remove.
	 * @returns {Promise}
	 */
	removeListener(routingKey) {
		return super.removeListener(routingKey)
			.then(() => {
				const topic = this.resolveTopic(routingKey);
				delete this.handlers[topic];
			});
	}

	/**
	 * Starts listening to messages.
	 * @returns {Promise}
	 */
	listen() {
		return super.listen()
			.then(() => {
				if (!this.queueUrl || !this.queueArn) {
					throw new Error('Unable to start listening, "connect()" should be called first.');
				}

				if (!this.consumer) {
					this.consumer = Consumer.create({
						queueUrl: this.queueUrl,
						handleMessage: ((message, done) => {
							const body = JSON.parse(message.Body || '{}');
							const correlationId = message.MessageAttributes.correlationId.StringValue;
							const initiator = message.MessageAttributes.initiator.StringValue || undefined;
							const topic = message.MessageAttributes.topic.StringValue;

							if (this.handlers[topic]) {
								this.handlers[topic](body, correlationId, initiator)
									.then(() => {
										done();
									})
									.catch((err) => {
										done(err);
									})
									.catch(() => {});
							} else {
								done(new Error(`No handlers were registered for topic ${JSON.stringify(topic)}`));
							}
						}),
						sqs: this.sqs,
						messageAttributeNames: ['correlationId', 'initiator']
					});

					this.consumer.on('error', (err) => {
						this.emit('error', err);
					});

					this.consumer.on('processing_error', (err) => {
						this.emit('error', err);
					});
				}

				this.consumer.start();
			});
	}

	/**
	 * Publishes a fire-and-forget message that is not expected to return a meaningful response.
	 * @param {string} routingKey - The routing key to attach to the message.
	 * @param {object} [message] - The message data to publish.
	 * @param {object} [options] - Optional publishing options.
	 * @param {object} [options.correlationId] - Optional marker used for tracing requests through the system.
	 * @param {object} [options.initiator] - Optional marker used for identifying the user who generated the initial request.
	 * @returns {Promise}
	 */
	publish(routingKey, message, options) {
		let correlationId;
		let topic;
		options = options || {};

		return super.publish(routingKey, message, options)
			.then((cId) => {
				correlationId = cId;
				topic = this.resolveTopic(routingKey);
				return this.sns.createTopic({ Name: topic }).promise();
			})
			.then((data) => this.sns.publish({
				Message: JSON.stringify(message),
				MessageAttributes: {
					correlationId: {
						DataType: 'String',
						StringValue: correlationId
					},
					initiator: {
						DataType: 'String',
						StringValue: options.initiator || ''
					},
					topic: {
						DataType: 'String',
						StringValue: topic
					}
				},
				TopicArn: data.TopicArn
			}).promise());
	}

	/**
	 * Publishes an RPC-style message that waits for a response.
	 * This function is not supported by the AWS transport, so calling this rejects
	 * with a NotImplementedError.
	 * @returns {Promise}
	 */
	request() {
		return Promise.reject(new errors.NotImplementedError('RPC-style requests are not supported by this transport.'));
	}
}

module.exports = AWSTransport;
