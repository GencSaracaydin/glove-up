// Tiny synchronous event bus shared by every module.
// Usage: const bus = new EventBus(); const off = bus.on('match:hit', fn); bus.emit('match:hit', payload); off();

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /** Subscribe. Returns an unsubscribe function. Use '*' to receive (name, payload) for every event. */
  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }

  off(name, fn) {
    const set = this._handlers.get(name);
    if (set) set.delete(fn);
  }

  emit(name, payload) {
    const set = this._handlers.get(name);
    if (set) for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[bus] handler for ${name} threw`, e); }
    }
    const all = this._handlers.get('*');
    if (all) for (const fn of [...all]) {
      try { fn(name, payload); } catch (e) { console.error('[bus] * handler threw', e); }
    }
  }

  clear() { this._handlers.clear(); }
}
