import { EventEmitter } from "node:events";

export type StreamEvent =
  | { event: "turn.status"; data: Record<string, unknown> }
  | { event: "item.append"; data: Record<string, unknown> }
  | { event: "hoot.updated"; data: Record<string, unknown> }
  | { event: "automation.fired"; data: Record<string, unknown> };

class Bus extends EventEmitter {
  publish(ev: StreamEvent) {
    this.emit("event", ev);
  }
}

export const bus = new Bus();
