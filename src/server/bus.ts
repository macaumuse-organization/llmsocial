import { EventEmitter } from 'node:events';
import type { StreamEvent } from '../shared/types.ts';

/** In-process fan-out to the browser's event stream. */
export class Bus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit(event: StreamEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(fn: (event: StreamEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
