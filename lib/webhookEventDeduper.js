const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function getWebhookEventId(event) {
  return event && typeof event.webhookEventId === 'string' ? event.webhookEventId : null;
}

function getRedeliveryState(event) {
  return event && event.deliveryContext && event.deliveryContext.isRedelivery === true;
}

function createWebhookEventDeduper({ getRedis, logger = console, ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  return async function shouldSkipWebhookEvent(event) {
    const eventId = getWebhookEventId(event);
    if (!eventId) return false;

    const redis = typeof getRedis === 'function' ? getRedis() : null;
    if (!redis) {
      logger.log(`[Webhook] Event: ${eventId} | Redelivery: ${getRedeliveryState(event)} | Dedup: unavailable`);
      return false;
    }

    try {
      const key = `line:webhook:event:${eventId}`;
      const result = await redis.set(key, '1', { ex: ttlSeconds, nx: true });
      const isDuplicate = result === null;
      logger.log(`[Webhook] Event: ${eventId} | Redelivery: ${getRedeliveryState(event)} | Duplicate: ${isDuplicate}`);
      return isDuplicate;
    } catch (error) {
      logger.error(`[Webhook] Dedup error: ${error.message}`);
      return false;
    }
  };
}

module.exports = { createWebhookEventDeduper, getWebhookEventId, getRedeliveryState };
