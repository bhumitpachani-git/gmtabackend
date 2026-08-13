const { EventEmitter } = require('events');

// One emitter per session, so a step handler running in the background can push each
// item to any SSE clients subscribed to that session the moment it's found, instead of
// clients only finding out once the whole job/poll cycle finishes.
const emitters = new Map();

function getEmitter(sessionId) {
  if (!emitters.has(sessionId)) emitters.set(sessionId, new EventEmitter());
  return emitters.get(sessionId);
}

function emitEvent(sessionId, event) {
  getEmitter(sessionId).emit('event', event);
}

function subscribe(sessionId, listener) {
  const emitter = getEmitter(sessionId);
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

module.exports = { emitEvent, subscribe };
