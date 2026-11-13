import { EventEmitter } from "node:events";

export type StreamEvent =
  | { event: "turn.status"; data: Record<string, unknown> }
  | { event: "item.append"; data: Record<string, unknown> }
  | { event: "hoot.updated"; data: Record<string, unknown> }
  | { event: "automation.fired"; data: Record<string, unknown> }
  | { event: "fact.changed"; data: Record<string, unknown> }
  | { event: "promise.changed"; data: Record<string, unknown> };

export type TaggedEvent = StreamEvent & { id: number };

class Bus extends EventEmitter {
  private seq = 0;
  private buffer: TaggedEvent[] = [];
  private readonly capacity = 500;

  publish(ev: StreamEvent): TaggedEvent {
    const tagged = { ...ev, id: ++this.seq } as TaggedEvent;
    this.buffer.push(tagged);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.emit("event", tagged);
    return tagged;
  }

  /** Events with id > since, for SSE replay after a reconnect. */
  since(sinceId: number): TaggedEvent[] {
    return this.buffer.filter((e) => e.id > sinceId);
  }

  get lastId(): number {
    return this.seq;
  }
}

export const bus = new Bus();
