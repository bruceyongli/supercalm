import { EventEmitter } from 'node:events';

// App-wide event bus. Modules emit; the HTTP layer fans events out to SSE clients.
//   bus.emit('changed')                  -> dashboard should refetch /api/state
//   bus.emit('event', {session, ...})    -> a structured session lifecycle event
//   bus.emit('output', {session, chunk}) -> raw terminal bytes for a session
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function changed() {
  bus.emit('changed');
}
