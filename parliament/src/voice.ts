// Screech (client): push-to-talk. Records, resamples to 16 kHz mono WAV in the
// browser, and hands the perch one small file. Browser handles every container
// (webm/ogg/mp4) so the daemon only ever sees WAV.

const TARGET_RATE = 16000;

export type Recording = { blob: Blob; ms: number };

export async function startRecording(): Promise<{ stop: () => Promise<Recording> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", ""].find(
    (m) => m === "" || (window.MediaRecorder && MediaRecorder.isTypeSupported(m))
  );
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  const started = Date.now();
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
  });
  rec.start(250);
  return {
    stop: async () => {
      rec.stop();
      stream.getTracks().forEach((t) => t.stop());
      const blob = await done;
      return { blob, ms: Date.now() - started };
    },
  };
}

/** Decode any browser-supported container and resample to 16 kHz mono WAV. */
export async function toWav16k(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(bytes);
  await ctx.close();

  const frames = Math.max(1, Math.ceil((decoded.duration * TARGET_RATE)));
  const off = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return new Blob([encodeWav(rendered.getChannelData(0), TARGET_RATE)], { type: "audio/wav" });
}

function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (const s of samples) {
    const clamped = Math.max(-1, Math.min(1, s));
    v.setInt16(o, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    o += 2;
  }
  return buf;
}
