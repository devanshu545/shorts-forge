// Procedural phonk-style music bed generator.
// 100% synthesized in the browser via OfflineAudioContext — no samples,
// no third-party audio, so it's copyright-free by construction.
// Deterministic per (seed, mood): same clip -> same bed; different clips
// -> different beds (BPM, key, drum variation, hat pattern, filter sweep).

export type PhonkMood = "chill" | "hype" | "classic";

// Small, fast seeded PRNG.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seedFor(index: number, aiTitle: string, startSeconds: number): number {
  return hashString(`${index}|${Math.round(startSeconds)}|${aiTitle || "clip"}`);
}

export function pickMoodFromTitle(title: string): PhonkMood {
  const t = (title || "").toLowerCase();
  if (/\b(chill|calm|sad|slow|soft|deep|lofi|relax|dream|quiet|peace)\b/.test(t)) return "chill";
  if (/\b(hype|insane|shock|crazy|win|fight|epic|beast|savage|rage|fire|god|10x)\b/.test(t)) return "hype";
  return "classic";
}

type MoodPreset = {
  bpm: number;
  rootHz: number;   // 808 root frequency (A1 ~ 55Hz)
  drive: number;   // saturation amount 0..1
  gain: number;    // master output
  filterHz: number; // low-pass ceiling for bed
};

function moodPreset(mood: PhonkMood, rand: () => number): MoodPreset {
  const roots = [55, 58.27, 61.74, 65.41, 49, 51.91]; // A1, A#1, B1, C2, G1, G#1
  const root = roots[Math.floor(rand() * roots.length)];
  if (mood === "chill") return { bpm: 80 + Math.floor(rand() * 10), rootHz: root, drive: 0.12, gain: 0.55, filterHz: 3200 };
  if (mood === "hype") return { bpm: 138 + Math.floor(rand() * 8), rootHz: root, drive: 0.45, gain: 0.7, filterHz: 5200 };
  return { bpm: 118 + Math.floor(rand() * 10), rootHz: root, drive: 0.28, gain: 0.62, filterHz: 4200 };
}

// Renders `seconds` of stereo audio and returns 16-bit PCM WAV bytes.
export async function generatePhonkBed(
  { seconds, seed, mood }: { seconds: number; seed: number; mood: PhonkMood },
): Promise<Uint8Array> {
  const sampleRate = 44100;
  const length = Math.max(2, Math.floor(seconds)) * sampleRate;
  type OACCtor = { new (numberOfChannels: number, length: number, sampleRate: number): OfflineAudioContext };
  const OAC: OACCtor =
    (window.OfflineAudioContext as unknown as OACCtor) ||
    ((window as unknown as { webkitOfflineAudioContext: OACCtor }).webkitOfflineAudioContext);
  if (!OAC) throw new Error("OfflineAudioContext unavailable");
  const ctx = new OAC(2, length, sampleRate);
  const rand = mulberry32(seed);
  const preset = moodPreset(mood, rand);
  const secPerBeat = 60 / preset.bpm;

  // Master chain: bus -> saturation -> low-pass -> gain -> destination
  const bus = ctx.createGain();
  bus.gain.value = 1;

  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  const k = preset.drive * 8 + 1;
  for (let i = 0; i < 1024; i++) {
    const x = (i / 1023) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  shaper.curve = curve;
  shaper.oversample = "2x";

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = preset.filterHz;
  lp.Q.value = 0.8;

  const master = ctx.createGain();
  master.gain.value = preset.gain;
  // Soft fade-in / fade-out so it never pops under the voice
  const total = seconds;
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(preset.gain, 0.35);
  master.gain.setValueAtTime(preset.gain, Math.max(0.36, total - 0.7));
  master.gain.linearRampToValueAtTime(0, total);

  bus.connect(shaper).connect(lp).connect(master).connect(ctx.destination);

  // Slow filter sweep for movement
  lp.frequency.setValueAtTime(preset.filterHz * 0.55, 0);
  lp.frequency.linearRampToValueAtTime(preset.filterHz, Math.min(total, 8));
  lp.frequency.linearRampToValueAtTime(preset.filterHz * 0.7, Math.max(0.5, total - 0.5));

  // --- Sound helpers ---
  const kick = (t: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.1, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.4);
  };

  const bass808 = (t: number, freq: number, dur: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq * 1.15, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.08);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  const hat = (t: number, open = false) => {
    const bufSize = Math.floor(sampleRate * (open ? 0.15 : 0.04));
    const buf = ctx.createBuffer(1, bufSize, sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.value = open ? 0.18 : 0.22;
    src.connect(hp).connect(g).connect(bus);
    src.start(t);
  };

  const cowbell = (t: number) => {
    const freqs = [560, 845];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.25);
    }
    g.connect(bus);
  };

  const pad = (t: number, freq: number, dur: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  // --- Pattern generation ---
  // Minor scale intervals (semitones): 0,3,5,7,10 — classic phonk feel
  const scale = [0, 3, 5, 7, 10];
  const semiToRatio = (n: number) => Math.pow(2, n / 12);

  // Choose a bassline (4 notes per bar, repeats)
  const bassPattern: number[] = [];
  for (let i = 0; i < 4; i++) bassPattern.push(scale[Math.floor(rand() * scale.length)]);

  // Kick variations (16th-note grid, 1 bar = 16 slots)
  const kickVariants: number[][] = [
    [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0],
  ];
  const kickPat = kickVariants[Math.floor(rand() * kickVariants.length)];
  const hatDensity = rand() > 0.5 ? 2 : 1; // 8ths vs 16ths
  const cowbellChance = mood === "hype" ? 0.35 : 0.18;

  const barSec = 4 * secPerBeat;
  const bars = Math.max(1, Math.ceil(total / barSec));
  for (let b = 0; b < bars; b++) {
    const barStart = b * barSec;
    if (barStart >= total) break;

    // Kicks
    for (let s = 0; s < 16; s++) {
      if (!kickPat[s]) continue;
      const t = barStart + (s / 16) * barSec;
      if (t < total - 0.05) kick(t);
    }

    // Bass — 1 note per beat, following bassPattern
    for (let i = 0; i < 4; i++) {
      const t = barStart + i * secPerBeat;
      if (t >= total) break;
      const freq = preset.rootHz * semiToRatio(bassPattern[i]);
      bass808(t, freq, secPerBeat * 0.9);
    }

    // Hats
    const steps = hatDensity === 2 ? 8 : 16;
    for (let s = 0; s < steps; s++) {
      const t = barStart + (s / steps) * barSec;
      if (t >= total) break;
      if (rand() > 0.15) hat(t, s % 8 === 7 && rand() > 0.6);
    }

    // Cowbell accents
    for (let s = 0; s < 16; s++) {
      if (rand() < cowbellChance && s % 4 !== 0) {
        const t = barStart + (s / 16) * barSec;
        if (t < total - 0.05) cowbell(t);
      }
    }

    // Pad chord (every 2 bars)
    if (b % 2 === 0) {
      const chord = [0, 3, 7].map((n) => preset.rootHz * 4 * semiToRatio(n + bassPattern[0]));
      for (const f of chord) pad(barStart, f, Math.min(barSec * 2, total - barStart));
    }
  }

  const rendered = await ctx.startRendering();
  return audioBufferToWav(rendered);
}

function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Uint8Array(out);
}
