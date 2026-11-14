// Screech v1 — local speech in.
// Parakeet TDT 0.6B v3 (25 languages, int8 ONNX) runs in-process via
// sherpa-onnx, CPU only. The model is ~671 MB, lazily loaded, and unloaded
// after idle so people who never speak keep a light daemon.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./log.js";

export const VOICE_MODEL_ID = "parakeet-tdt-0.6b-v3-int8";
const HF_BASE = `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main`;
const FILES: { name: string; bytes: number }[] = [
  { name: "encoder.int8.onnx", bytes: 652282294 },
  { name: "decoder.int8.onnx", bytes: 11845274 },
  { name: "joiner.int8.onnx", bytes: 6355277 },
  { name: "tokens.txt", bytes: 93939 },
];
const IDLE_UNLOAD_MS = 5 * 60_000;

export const modelDir = () => path.join(config.dataDir, "models", VOICE_MODEL_ID);

export function modelStatus(): {
  present: boolean;
  bytes: number;
  expected: number;
  loaded: boolean;
  pulling: boolean;
} {
  const dir = modelDir();
  let bytes = 0;
  let present = true;
  for (const f of FILES) {
    const p = path.join(dir, f.name);
    if (!existsSync(p)) {
      present = false;
      continue;
    }
    bytes += statSync(p).size;
  }
  const expected = FILES.reduce((n, f) => n + f.bytes, 0);
  // A short file means an interrupted download.
  if (present && bytes < expected * 0.99) present = false;
  return { present, bytes, expected, loaded: recognizer !== null, pulling };
}

let pulling = false;
let pullPromise: Promise<void> | null = null;

/** Download the model once; idempotent and safe to call concurrently. */
export function pullModel(): Promise<void> {
  if (pullPromise) return pullPromise;
  pulling = true;
  pullPromise = (async () => {
    const dir = modelDir();
    mkdirSync(dir, { recursive: true });
    for (const f of FILES) {
      const target = path.join(dir, f.name);
      if (existsSync(target) && statSync(target).size >= f.bytes * 0.99) continue;
      logger.info("voice model: downloading", { file: f.name, bytes: f.bytes });
      const res = await fetch(`${HF_BASE}/${f.name}`);
      if (!res.ok || !res.body) throw new Error(`download ${f.name}: ${res.status}`);
      const tmp = `${target}.part`;
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(tmp);
        const reader = res.body!.getReader();
        (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once("drain", () => r()));
          }
          out.end(() => resolve());
        })().catch((err) => {
          out.destroy();
          if (existsSync(tmp)) unlinkSync(tmp);
          reject(err);
        });
      });
      if (existsSync(target)) unlinkSync(target);
      renameSync(tmp, target);
      logger.info("voice model: file ready", { file: f.name });
    }
    logger.info("voice model: ready", { dir });
  })().finally(() => {
    pulling = false;
    pullPromise = null;
  });
  return pullPromise;
}

// --- recognition -------------------------------------------------------------

type Recognizer = {
  createStream: () => any;
  decode: (s: any) => void;
  getResult: (s: any) => { text: string };
};

let recognizer: Recognizer | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    recognizer = null;
    logger.info("voice model: unloaded after idle");
  }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

async function getRecognizer(): Promise<Recognizer> {
  if (recognizer) {
    touchIdle();
    return recognizer;
  }
  const dir = modelDir();
  const mod: any = await import("sherpa-onnx-node");
  const sherpa = mod.default ?? mod;
  const rec: Recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, "encoder.int8.onnx"),
        decoder: path.join(dir, "decoder.int8.onnx"),
        joiner: path.join(dir, "joiner.int8.onnx"),
      },
      tokens: path.join(dir, "tokens.txt"),
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });
  recognizer = rec;
  logger.info("voice model: loaded", { dir });
  touchIdle();
  return rec;
}

export type Audio = { samples: Float32Array; sampleRate: number };

/** Minimal 16-bit PCM WAV reader (the shape the web UI sends). */
export function decodeWav(buf: Buffer): Audio {
  const rate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const data = buf.subarray(off + 8, off + 8 + size);
      const frames = Math.floor(data.length / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
        samples[i] = sum / channels / 32768;
      }
      return { samples, sampleRate: rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("wav: no data chunk");
}

/** OGG/Opus (Telegram voice notes). */
export async function decodeOggOpus(buf: Buffer): Promise<Audio> {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const decoder: any = new OggOpusDecoder();
  try {
    const res = await decoder.decodeFile(new Uint8Array(buf));
    return { samples: res.samplesDecoded, sampleRate: res.sampleRate };
  } finally {
    decoder.free?.();
  }
}

/** Pick a decoder by content type or magic bytes. */
export async function decodeAudio(buf: Buffer, contentType = ""): Promise<Audio> {
  if (contentType.includes("ogg") || buf.subarray(0, 4).toString("ascii") === "OggS") {
    return decodeOggOpus(buf);
  }
  if (contentType.includes("wav") || buf.subarray(0, 4).toString("ascii") === "RIFF") {
    return decodeWav(buf);
  }
  try {
    return await decodeOggOpus(buf);
  } catch {
    return decodeWav(buf);
  }
}

export async function transcribe(audio: Audio): Promise<string> {
  const rec = await getRecognizer();
  const stream = rec.createStream();
  stream.acceptWaveform({ sampleRate: audio.sampleRate, samples: audio.samples });
  rec.decode(stream);
  return (rec.getResult(stream).text ?? "").trim();
}

export async function transcribeBuffer(buf: Buffer, contentType = ""): Promise<string> {
  const audio = await decodeAudio(buf, contentType);
  return transcribe(audio);
}
