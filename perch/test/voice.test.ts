import { describe, it, expect } from "vitest";
import { decodeWav, modelStatus } from "../src/voice.js";

function wavOf(samples: number[], rate = 16000): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
}

describe("voice wav decoding", () => {
  it("round-trips samples at full scale", () => {
    const pcm = [0, 16384, -16384, 32767, -32768];
    const { samples, sampleRate } = decodeWav(wavOf(pcm));
    expect(sampleRate).toBe(16000);
    expect(samples.length).toBe(pcm.length);
    expect(samples[1]).toBeCloseTo(0.5, 3);
    expect(samples[2]).toBeCloseTo(-0.5, 3);
  });

  it("handles stereo by averaging channels", () => {
    const buf = wavOf([1000, 1000, -1000, -1000]);
    // patch header to stereo
    buf.writeUInt16LE(2, 22);
    const { samples } = decodeWav(buf);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(1000 / 32768, 5);
  });

  it("reports model status honestly", () => {
    const s = modelStatus();
    expect(s.expected).toBeGreaterThan(600_000_000);
    expect(typeof s.present).toBe("boolean");
  });
});
