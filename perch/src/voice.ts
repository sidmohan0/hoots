// Screech v1 — local speech in.
// Parakeet TDT 0.6B v3 (25 languages, int8 ONNX) runs in-process via
// sherpa-onnx, CPU only. The model is ~671 MB, lazily loaded, and unloaded
// after idle so people who never speak keep a light daemon.

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./log.js";

export const VOICE_MODEL_ID = "parakeet-tdt-0.6b-v3-int8";
// Voice out: a small Piper voice, same runtime as the recogniser.
export const TTS_MODEL_ID = "csukuangfj/vits-piper-en_US-amy-low";
const TTS_HF = `https://huggingface.co/${TTS_MODEL_ID}`;
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
    const res: any = await decoder.decodeFile(new Uint8Array(buf));
    const ch: Float32Array | undefined = res?.channelData?.[0] ?? res?.samplesDecoded;
    if (!ch?.length) throw new Error("opus: no samples");
    return { samples: ch, sampleRate: res.sampleRate };
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


// --- voice out (Piper / VITS) -------------------------------------------------

export const ttsModelDir = () => path.join(config.dataDir, "models", "vits-piper-en_US-amy-low");

let ttsPulling = false;
let ttsPromise: Promise<void> | null = null;
let tts: any = null;

export function ttsStatus(): { present: boolean; loaded: boolean; pulling: boolean } {
  const dir = ttsModelDir();
  const present = existsSync(path.join(dir, "tokens.txt")) && existsSync(path.join(dir, "espeak-ng-data"));
  return { present, loaded: tts !== null, pulling: ttsPulling };
}

/** Pull the voice once (files listed from the hub, fetched concurrently). */
export function pullTtsModel(): Promise<void> {
  if (ttsPromise) return ttsPromise;
  ttsPulling = true;
  ttsPromise = (async () => {
    const dir = ttsModelDir();
    mkdirSync(path.join(dir, "espeak-ng-data"), { recursive: true });
    const listing = await fetch(`https://huggingface.co/api/models/${TTS_MODEL_ID}`, {
      headers: { "user-agent": "hoots-perch" },
    });
    if (!listing.ok) throw new Error(`voice out listing: ${listing.status}`);
    const tree: any = await listing.json();
    if (!Array.isArray(tree.siblings)) throw new Error("voice out listing: no siblings");
    const files: string[] = tree.siblings
      .map((f: any) => f.rfilename as string)
      .filter((f: string) => /\.(onnx|txt)$/.test(f) || f.startsWith("espeak-ng-data/"));
    let next = 0;
    const worker = async () => {
      for (;;) {
        const file = files[next++];
        if (!file) return;
        const target = path.join(dir, file);
        if (existsSync(target)) continue;
        mkdirSync(path.dirname(target), { recursive: true });
        const res = await fetch(`${TTS_HF}/resolve/main/${file}`);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const { writeFileSync } = await import("node:fs");
        writeFileSync(target, buf);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    logger.info("voice out: model ready", { dir, files: files.length });
  })().finally(() => {
    ttsPulling = false;
    ttsPromise = null;
  });
  return ttsPromise;
}

async function getTts(): Promise<any> {
  if (tts) return tts;
  const mod: any = await import("sherpa-onnx-node");
  const sherpa = mod.default ?? mod;
  const dir = ttsModelDir();
  tts = new sherpa.OfflineTts({
    model: {
      vits: {
        model: path.join(dir, "en_US-amy-low.onnx"),
        tokens: path.join(dir, "tokens.txt"),
        dataDir: path.join(dir, "espeak-ng-data"),
      },
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    maxNumSentences: 1,
  });
  logger.info("voice out: loaded");
  return tts;
}

// Phonemisation: sherpa's TTS config ignores dataDir, so espeak (WASM) gives
// us IPA and we map it onto the voice's token table. Cached, single instance.
let espeak: any = null;
let phonemeTable: Set<string> | null = null;

async function phonemize(text: string): Promise<string[][]> {
  if (!espeak) {
    const mod: any = await import("espeak-ng");
    espeak = await (mod.default ?? mod)({});
  }
  if (!phonemeTable) {
    const tokens = readFileSync(path.join(ttsModelDir(), "tokens.txt"), "utf8").trim().split("\n");
    phonemeTable = new Set(tokens.map((l) => l.split(" ")[0]));
  }
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 12);
  const out: string[][] = [];
  for (const sentence of sentences) {
    const outFile = `ph${Math.random().toString(36).slice(2)}`;
    const inst = await (await import("espeak-ng")).default({
      arguments: ["--phonout", outFile, '--sep=""', "-q", "-b=1", "--ipa=3", "-v", "en-us", JSON.stringify(sentence)],
    } as any);
    const ipa = String(inst.FS.readFile(outFile, { encoding: "utf8" })).replace(/\u200d/g, "").trim();
    const tokens: string[] = [];
    for (let i = 0; i < ipa.length; ) {
      let matched: string | null = null;
      for (const len of [3, 2, 1]) {
        const cand = ipa.slice(i, i + len);
        if (phonemeTable!.has(cand)) {
          matched = cand;
          break;
        }
      }
      if (matched) {
        tokens.push(matched);
        i += matched.length;
      } else {
        i += 1;
      }
    }
    if (tokens.length) out.push(tokens);
  }
  return out;
}

/** Strip what shouldn't be read out loud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>]+/g, "")
    .replace(/^\s*-\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

/** Synthesise speech; returns 16-bit mono WAV bytes. */
export async function speak(rawText: string, speed = 1.0): Promise<Buffer> {
  const text = speakable(rawText);
  if (!text) throw new Error("nothing to say");
  const engine = await getTts();
  const sentences = await phonemize(text);
  if (!sentences.length) throw new Error("nothing to say");
  const chunks: Float32Array[] = [];
  let rate = 16000;
  for (const tokens of sentences) {
    const audio = await engine.generateAsync({ text: "", sid: 0, speed, generationConfig: { tokens: [tokens] } });
    if (audio.samples?.length) {
      chunks.push(audio.samples as Float32Array);
      rate = audio.sampleRate as number;
    }
  }
  if (!chunks.length) throw new Error("TTS generation produced no audio");
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  return encodeWav16(merged, rate);
}

export function encodeWav16(samples: Float32Array, rate: number): Buffer {
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
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}


// --- voice out to Telegram: WAV -> OGG/Opus ---------------------------------
// Telegram voice notes are OGG containers of Opus frames at 48 kHz. We encode
// with libopus (native) and write a minimal, spec-correct OGG stream.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let b = 0; b < 8; b++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0;
  for (const byte of buf) c = (CRC_TABLE[((c >>> 24) ^ byte) & 0xff] ^ (c << 8)) >>> 0;
  return c;
}

function oggPage(serial: number, seq: number, granule: bigint, packet: Buffer, headerType = 0): Buffer {
  const lacing: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  const head = Buffer.alloc(27);
  head.write("OggS", 0);
  head.writeUInt8(0, 4); // version
  head.writeUInt8(headerType, 5);
  head.writeBigInt64LE(granule, 6);
  head.writeUInt32LE(serial >>> 0, 14);
  head.writeUInt32LE(seq >>> 0, 18);
  head.writeUInt32LE(0, 22); // crc placeholder
  head.writeUInt8(lacing.length, 26);
  const page = Buffer.concat([head, Buffer.from(lacing), packet]);
  page.writeUInt32LE(crc32(page), 22);
  return page;
}

function resampleTo48k(samples: Float32Array, rate: number): Float32Array {
  if (rate === 48000) return samples;
  const ratio = 48000 / rate;
  const out = new Float32Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = samples[i0] ?? 0;
    const b = samples[Math.min(i0 + 1, samples.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export type WavAudio = { samples: Float32Array; sampleRate: number };

/** Encode 16-bit mono PCM (any rate) as an OGG/Opus voice note. */
export async function encodeOggOpus(audio: WavAudio): Promise<Buffer> {
  const mod: any = await import("@discordjs/opus");
  const OpusEncoder = mod.OpusEncoder ?? mod.default?.OpusEncoder;
  const enc = new OpusEncoder(48000, 1);
  const pcm = resampleTo48k(audio.samples, audio.sampleRate);
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const chunks: Buffer[] = [];

  const head = Buffer.alloc(19);
  head.write("OpusHead", 0);
  head.writeUInt8(1, 8);
  head.writeUInt8(1, 9);
  head.writeUInt16LE(312, 10); // pre-skip
  head.writeUInt32LE(48000, 12);
  head.writeInt16LE(0, 16);
  head.writeUInt8(0, 18);
  chunks.push(oggPage(serial, 0, 0n, head, 0x02));

  const vendor = Buffer.from("hoots", "utf8");
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  chunks.push(oggPage(serial, 1, 0n, tags));

  const FRAME = 960; // 20 ms at 48 kHz
  let seq = 2;
  let granule = 0;
  for (let i = 0; i < pcm.length; i += FRAME) {
    const slice = pcm.subarray(i, Math.min(i + FRAME, pcm.length));
    const int16 = Buffer.alloc(slice.length * 2);
    for (let j = 0; j < slice.length; j++) {
      const v = Math.max(-1, Math.min(1, slice[j]));
      int16.writeInt16LE(Math.round(v * 32767), j * 2);
    }
    let packet: Buffer;
    try {
      packet = enc.encode(int16);
    } catch {
      continue;
    }
    granule += slice.length;
    chunks.push(oggPage(serial, seq++, BigInt(granule), packet));
  }
  return Buffer.concat(chunks);
}
