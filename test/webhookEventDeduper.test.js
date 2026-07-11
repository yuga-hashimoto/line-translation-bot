const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebhookEventDeduper, getRedeliveryState, getWebhookEventId } = require('../lib/webhookEventDeduper');

test('extracts LINE webhook event id and redelivery state', () => {
  const event = {
    webhookEventId: 'event-1',
    deliveryContext: { isRedelivery: true },
  };

  assert.equal(getWebhookEventId(event), 'event-1');
  assert.equal(getRedeliveryState(event), true);
});

test('skips duplicate LINE webhook events using Redis nx marker', async () => {
  const calls = [];
  const redis = {
    async set(key, value, options) {
      calls.push({ key, value, options });
      return calls.length === 1 ? 'OK' : null;
    },
  };
  const logger = { log() {}, error() {} };
  const shouldSkip = createWebhookEventDeduper({ getRedis: () => redis, logger, ttlSeconds: 60 });
  const event = { webhookEventId: 'event-1', deliveryContext: { isRedelivery: false } };

  assert.equal(await shouldSkip(event), false);
  assert.equal(await shouldSkip(event), true);
  assert.deepEqual(calls[0], {
    key: 'line:webhook:event:event-1',
    value: '1',
    options: { ex: 60, nx: true },
  });
});

test('does not skip events when id or Redis is unavailable', async () => {
  const logger = { log() {}, error() {} };
  const shouldSkip = createWebhookEventDeduper({ getRedis: () => null, logger });

  assert.equal(await shouldSkip({}), false);
  assert.equal(await shouldSkip({ webhookEventId: 'event-1' }), false);
});
