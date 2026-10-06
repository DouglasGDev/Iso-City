/**
 * Sintetiza SFX e ambientes originais como WAV PCM16 mono 22.05kHz.
 * Rode: node tools/generate-sfx.js (todos), --weapons (armas) ou
 * --exploration (movimento, floresta, chamado animal e buzina), --regions (biomas),
 * --weather (vento e trovão), --hazards (tornado, onda, cachoeira e sirene de aviso) e
 * --frontier (a voz e o passo do gorila, a morte do rotor e o reacender na mata) e
 * --tribo (o grito de guerra do bando e o tambor do acampamento).
 */
const fs = require('fs');
const path = require('path');

const SR = 22050;
const OUT = path.join(__dirname, '..', 'assets', 'Audio', 'generated');

function writeWav(name, samples, peakLevel = 0.89) {
  if (!(peakLevel > 0 && peakLevel < 1)) throw new Error(`${name}: invalid peak level`);
  let peak = 0;
  for (const s of samples) {
    if (!Number.isFinite(s)) throw new Error(`${name}: non-finite sample`);
    peak = Math.max(peak, Math.abs(s));
  }
  if (!samples.length || !peak) throw new Error(`${name}: empty or silent sound`);
  const gain = peakLevel / peak;
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let sumSquares = 0;
  let pcmPeak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, samples[i] * gain)) * 32767);
    buf.writeInt16LE(v, 44 + i * 2);
    sumSquares += (v / 32767) ** 2;
    pcmPeak = Math.max(pcmPeak, Math.abs(v) / 32767);
  }
  fs.writeFileSync(path.join(OUT, name), buf);
  const rmsDb = 10 * Math.log10(sumSquares / n);
  const peakDb = 20 * Math.log10(pcmPeak);
  console.log(`${name}: ${(buf.length / 1024).toFixed(0)} KB, ${(n / SR).toFixed(2)}s, ` +
    `peak ${peakDb.toFixed(1)} dBFS, RMS ${rmsDb.toFixed(1)} dBFS`);
}

// one-pole lowpass stateful
function lowpass(src, coef) {
  const out = new Float32Array(src.length);
  let y = 0;
  for (let i = 0; i < src.length; i++) {
    y += coef * (src[i] - y);
    out[i] = y;
  }
  return out;
}

let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
}

function sec(s) {
  return Math.round(s * SR);
}

// ---- Sirene (loop 4s): uivo policial duas tons, harmônicas pra timbre real ----
function siren() {
  const n = sec(4);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n; // 0..1 em 4s
    // varredura suave 620→1080→620 (2 ciclos p/ loop)
    const f = 850 + 230 * Math.sin(2 * Math.PI * 2 * t);
    phase += (2 * Math.PI * f) / SR;
    const w = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t); // amplitude tremolo (4 ciclos)
    out[i] =
      w *
      (Math.sin(phase) * 0.7 +
        Math.sin(phase * 2) * 0.22 +
        Math.sin(phase * 3) * 0.08);
  }
  // cruzar 40ms pra emendar o loop
  const xf = sec(0.04);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    out[i] = out[i] * a + out[n - xf + i] * (1 - a);
  }
  writeWav('siren_loop.wav', out);
}

// ---- Motor (loop 1s): ronco de marcha lenta, harmônicas + ruído ----
function engine() {
  const n = sec(1);
  const raw = new Float32Array(n);
  const f0 = 65; // 65 ciclos inteiros em 1s → loop perfeito
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const p = 2 * Math.PI * f0 * t;
    raw[i] =
      Math.sin(p) * 0.6 +
      Math.sin(2 * p) * 0.35 +
      Math.sin(3 * p + 0.4) * 0.2 +
      Math.sin(5 * p) * 0.08 +
      rnd() * 0.06 +
      Math.sin(2 * Math.PI * 8 * t) * 0.06 * Math.sin(p); // misfire leve
  }
  const out = lowpass(raw, 0.25);
  writeWav('engine_loop.wav', out);
}

// ---- Rotor policial (loop 1s): "whup-whup" das pás sobre um corpo grave ----
function heliRotor() {
  const saved = seed; // semente própria: os demais geradores mantêm a mesma sequência
  seed = 90210;
  const n = sec(1);
  const passes = 5; // 5 passagens de pá por segundo (ciclo inteiro em 1s → loop perfeito)
  const raw = new Float32Array(n);
  const air = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const p = 2 * Math.PI * 55 * t; // 55 ciclos em 1s
    const phase = (t * passes) % 1;
    // ataque de ~6ms e cauda exponencial: a emenda entra e sai em silêncio
    const env = (1 - Math.exp(-phase * 160)) * Math.exp(-phase * 6);
    const thump = Math.sin(2 * Math.PI * 22 * phase) * env;
    raw[i] = Math.sin(p) * 0.5 + Math.sin(2 * p + 0.4) * 0.22 + thump * 0.8;
    air[i] = rnd() * env * 0.6;
  }
  const body = lowpass(raw, 0.14);
  const swish = lowpass(air, 0.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = body[i] * 1.5 + swish[i] * 1.1;
  writeWav('heli_rotor.wav', out, 0.7);
  seed = saved;
}

// ---- Explosão: sub sweep + ruído decaindo ----
function explosion() {
  const n = sec(1.6);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-3.1 * t);
    const sub = Math.sin(2 * Math.PI * (90 * Math.exp(-2.2 * t) + 28) * t);
    out[i] = (rnd() * 0.9 + sub * 1.1) * env;
  }
  const lp = lowpass(out, 0.08);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // ataque seco nos primeiros 30ms: mantém um pouco do corpo
    out[i] = lp[i] * 1.6 + rnd() * 0.12 * Math.exp(-25 * t);
  }
  writeWav('explosion.wav', out);
}

// ---- Soco: whoosh de ruído filtrado + thump ----
function punch() {
  const n = sec(0.22);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const whoosh = rnd() * Math.exp(-18 * t) * (t < 0.09 ? 0.8 : 0.12);
    const thump = Math.sin(2 * Math.PI * (150 * Math.exp(-9 * t) + 55) * t) * Math.exp(-14 * t);
    out[i] = whoosh + thump * (t > 0.05 ? 1.4 : 0.2);
  }
  writeWav('punch.wav', out);
}

// ---- Ambiente noturno (loop 8s): vento suave + grilos distantes ----
function nightAmbience() {
  const n = sec(8);
  const wind = new Float32Array(n);
  const mod = 0.16 + 0.09 * Math.sin(2 * Math.PI * (1 / 8) * (0.5 + wind.length / SR / 2)) * 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    wind[i] = rnd() * (0.2 + 0.08 * Math.sin(2 * Math.PI * 0.25 * t) + 0.05 * Math.sin(2 * Math.PI * 0.5 * t));
  }
  const lp = lowpass(lowpass(wind, 0.035), 0.035);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lp[i] * 2.2 + mod;
  // grilos: trens de 4kHz em pulsos, 2 sítios fixos no ciclo (4s e 6.2s)
  const chirp = (start, count) => {
    for (let c = 0; c < count; c++) {
      const t0 = (start + c * 0.055) * SR;
      for (let i = 0; i < sec(0.028); i++) {
        const idx = Math.floor(t0 + i);
        if (idx >= n) continue;
        const a = Math.sin((Math.PI * i) / sec(0.028));
        out[idx] += Math.sin(2 * Math.PI * 4200 * (i / SR)) * a * 0.16;
      }
    }
  };
  chirp(1.2, 4);
  chirp(3.4, 3);
  chirp(5.1, 5);
  writeWav('ambient_city_night.wav', out);
}

function gunshot(name, body, decay) {
  const out = new Float32Array(sec(0.24));
  let filtered = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = rnd();
    filtered += 0.3 * (noise - filtered);
    const attack = Math.min(1, t / 0.001);
    out[i] = attack * (noise * 0.55 * Math.exp(-t * 145) +
      filtered * 1.2 * Math.exp(-t * decay) +
      Math.sin(2 * Math.PI * body * t) * 0.6 * Math.exp(-t * 40));
  }
  writeWav(name, out);
}

/** Rifle: sharper, longer report with a low crack tail. Shotgun: wide dual burst. */
function shotgunBlast(name) {
  const out = new Float32Array(sec(0.36));
  let hp = 0, lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const noise = rnd();
    hp += 0.55 * (noise - hp);
    lp += 0.06 * (noise - lp);
    const attack = Math.min(1, t / 0.0015);
    const body = Math.sin(2 * Math.PI * (72 * Math.exp(-6 * t) + 44) * t) * Math.exp(-t * 18);
    out[i] = attack * (hp * 0.9 * Math.exp(-t * 42) + lp * 1.5 * Math.exp(-t * 9) + body * 0.85);
  }
  writeWav(name, out);
}

/** Taco: arcing whoosh followed by a dry wooden crack. */
function batSwing(name) {
  const out = new Float32Array(sec(0.34));
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const sweep = 0.32 + 0.5 * Math.min(1, t / 0.14);
    lp += sweep * (rnd() - lp);
    const whoosh = lp * 1.4 * Math.sin(Math.PI * Math.min(1, t / 0.16)) * Math.exp(-t * 5);
    const crack = Math.sin(2 * Math.PI * (420 * Math.exp(-22 * (t - 0.13)) + 180) * t) *
      Math.exp(-(t - 0.13) * 90) * (t > 0.13 ? 1 : 0);
    const knock = Math.sin(2 * Math.PI * 160 * t) * Math.exp(-Math.max(0, t - 0.13) * 40) *
      (t > 0.13 ? 0.7 : 0);
    out[i] = whoosh + crack * 0.9 + knock;
  }
  writeWav(name, lowpass(out, 0.62));
}

/** Taco atingindo algo: impacto seco de madeira, sem cauda de soco. */
function batHit(name) {
  const out = new Float32Array(sec(0.19));
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    lp += 0.45 * (rnd() - lp);
    const knock = Math.sin(2 * Math.PI * 245 * t) * Math.exp(-t * 34) +
      Math.sin(2 * Math.PI * 610 * t) * Math.exp(-t * 58) * 0.5;
    out[i] = lp * 0.85 * Math.exp(-t * 95) + knock * 1.15;
  }
  writeWav(name, out);
}

function gunMechanism(name, clicks, length) {
  const out = new Float32Array(sec(length));
  for (const start of clicks) {
    for (let i = 0; i < sec(0.05); i++) {
      const t = i / SR;
      const index = sec(start) + i;
      if (index < out.length) out[index] +=
        (rnd() * 0.65 + Math.sin(t * 2 * Math.PI * 1650) * 0.15) * Math.exp(-t * 135);
    }
  }
  writeWav(name, out);
}

// Fades nos one-shots: zero nas bordas, sem estalo na criação/descarte do player.
function oneShot(name, samples, peak) {
  const attack = sec(0.006);
  const release = sec(0.035);
  for (let i = 0; i < samples.length; i++) {
    const fade = Math.min(1, i / attack, (samples.length - 1 - i) / release);
    samples[i] *= Math.sin(fade * Math.PI / 2) ** 2;
  }
  writeWav(name, samples, peak);
}

// Salto: impulso leve e ar ascendente, sem impacto de aterrissagem.
function jump() {
  const out = new Float32Array(sec(0.32));
  let air = 0, phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    air += (0.08 + t * 0.8) * (rnd() - air);
    phase += 2 * Math.PI * (150 + 650 * t) / SR;
    const env = Math.sin(Math.PI * i / (out.length - 1)) ** 2;
    out[i] = air * env * 0.8 + Math.sin(phase) * Math.exp(-t * 18) * 0.24;
  }
  oneShot('jump.wav', out, 0.55);
}

// Aterrissagem: peso grave + atrito curto no chão.
function land() {
  const out = new Float32Array(sec(0.30));
  let grit = 0, phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    grit += 0.2 * (rnd() - grit);
    phase += 2 * Math.PI * (55 + 95 * Math.exp(-t * 22)) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t * 20) + grit * 0.8 * Math.exp(-t * 28);
  }
  oneShot('land.wav', out, 0.68);
}

// Vault: passagem de roupa/ar mais longa com apoio seco da mão.
function vault() {
  const out = new Float32Array(sec(0.52));
  let air = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    air += 0.14 * (rnd() - air);
    const env = Math.sin(Math.PI * i / (out.length - 1)) ** 2;
    const hit = Math.max(0, t - 0.10);
    const palm = t > 0.10 ? Math.sin(2 * Math.PI * 210 * hit) * Math.exp(-hit * 55) : 0;
    out[i] = air * env + palm * 0.38;
  }
  oneShot('vault.wav', out, 0.58);
}

// Morte: sinal grave descendente, separado do jingle "wasted" existente.
function death() {
  const out = new Float32Array(sec(1.25));
  let phase = 0, air = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase += 2 * Math.PI * (48 + 170 * Math.exp(-t * 2.8)) / SR;
    air += 0.035 * (rnd() - air);
    const env = Math.min(1, t / 0.045) * Math.exp(-t * 3.2);
    out[i] = (Math.sin(phase) + Math.sin(phase * 2) * 0.22 + air * 0.5) * env;
  }
  oneShot('death.wav', out, 0.65);
}

// Buzina automotiva de dois tons sustentados (não um impacto metálico).
function carHorn() {
  const out = new Float32Array(sec(0.72));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.025, (out.length - 1 - i) / sec(0.11));
    const reed = (hz) => {
      const p = 2 * Math.PI * hz * t;
      return Math.sin(p) + Math.sin(2 * p) * 0.32 + Math.sin(3 * p) * 0.16;
    };
    out[i] = (reed(370) + reed(466) * 0.85) * env * (0.96 + 0.04 * Math.cos(2 * Math.PI * 13 * t));
  }
  oneShot('car_horn.wav', out, 0.70);
}

// Chamado estilizado de mamífero distante, duas vocalizações sem fala.
function animalCall() {
  const out = new Float32Array(sec(1.05));
  for (const [start, duration, base] of [[0.04, 0.38, 490], [0.54, 0.30, 410]]) {
    let phase = 0;
    for (let i = 0; i < sec(duration); i++) {
      const t = i / SR;
      const u = i / (sec(duration) - 1);
      phase += 2 * Math.PI * (base + 180 * Math.sin(Math.PI * u) + 12 * Math.sin(2 * Math.PI * 23 * t)) / SR;
      out[sec(start) + i] += Math.sin(Math.PI * u) ** 2 *
        (Math.sin(phase) + Math.sin(phase * 2) * 0.3 + rnd() * 0.07);
    }
  }
  oneShot('animal_call.wav', out, 0.44);
}

// Ruído contínuo: a cauda extra cruza o início, mantendo a emenda natural.
function forestNoise(n, coefficient) {
  const crossfade = sec(0.25);
  const raw = new Float32Array(n + crossfade);
  for (let i = 0; i < raw.length; i++) raw[i] = rnd();
  const filtered = lowpass(lowpass(raw, coefficient), coefficient);
  const out = filtered.slice(0, n);
  for (let i = 0; i < crossfade; i++) {
    const a = i / (crossfade - 1);
    out[i] = filtered[n + i] * (1 - a) + filtered[i] * a;
  }
  return out;
}

function forestAmbience(night) {
  const n = sec(12);
  const wind = forestNoise(n, 0.025);
  const leaves = forestNoise(n, 0.20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cycle = 2 * Math.PI * i / n;
    out[i] = wind[i] * (0.9 + 0.22 * Math.sin(cycle * 2)) +
      leaves[i] * (night ? 0.035 : 0.07) * (0.8 + 0.2 * Math.cos(cycle * 3));
  }
  const bird = (start, duration, base, amplitude) => {
    let phase = 0;
    const count = sec(duration);
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      phase += 2 * Math.PI * (base + base * 0.16 * Math.sin(Math.PI * u)) / SR;
      out[sec(start) + i] += Math.sin(phase) * Math.sin(Math.PI * u) ** 2 * amplitude;
    }
  };
  if (night) {
    // Grilos em grupos, abaixo de Nyquist; coruja discreta longe da emenda.
    for (const start of [0.9, 2.8, 5.2, 7.1, 9.6, 10.8]) {
      for (let c = 0; c < 4; c++) bird(start + c * 0.07, 0.035, 3600, 0.028);
    }
    bird(3.8, 0.38, 390, 0.038);
    bird(4.35, 0.52, 340, 0.032);
  } else {
    // Pares de cantos agudos com pausas, sobre vento/folhagem contínuos.
    for (const [start, base] of [[0.8, 1900], [3.2, 2400], [6.7, 1700], [9.5, 2150]]) {
      bird(start, 0.16, base, 0.055);
      bird(start + 0.24, 0.23, base * 1.18, 0.042);
    }
  }
  // Remover DC do ruído filtrado sem alterar a continuidade da emenda.
  let mean = 0;
  for (const sample of out) mean += sample / n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  writeWav(night ? 'forest_night.wav' : 'forest_day.wav', out, night ? 0.23 : 0.28);
}

// Ambientes regionais inteiramente sintetizados, sem gravações, downloads ou samples externos.
// Cada seed independe da ordem/flag de geração. 6s PCM mono = ~259KB por loop.
function regionAmbience(region, night) {
  const names = ['coast', 'industry', 'country', 'pinewood', 'savanna', 'desert'];
  seed = 91273 + names.indexOf(region) * 7919 + (night ? 311 : 0);
  const n = sec(6), out = new Float32Array(n);
  const bass = forestNoise(n, region === 'coast' ? 0.07 : region === 'desert' ? 0.03 : 0.018);
  const air = forestNoise(n, region === 'savanna' ? 0.32 : 0.16);
  for (let i = 0; i < n; i++) {
    const t = i / SR, cycle = 2 * Math.PI * i / n;
    if (region === 'coast') {
      // Duas ondas lentas: massa grave e espuma, sem pausa na emenda.
      const surf = (0.5 + 0.5 * Math.sin(cycle * 2)) ** 2;
      out[i] = bass[i] * (0.7 + surf * 1.3) + air[i] * (0.03 + surf * 0.24);
    } else if (region === 'industry') {
      // Ventilação e máquinas distantes; frequências/ciclos inteiros em seis segundos.
      const motor = Math.sin(2 * Math.PI * 55 * t) * 0.022 + Math.sin(2 * Math.PI * 110 * t) * 0.011;
      out[i] = bass[i] * 0.55 + air[i] * 0.025 + motor * (night ? 0.45 : 1) * (0.8 + 0.2 * Math.cos(cycle));
    } else if (region === 'desert') {
      // Vento seco em rajadas lentas: sem folha, sem água, quase nada vivo.
      const gust = (0.55 + 0.45 * Math.sin(cycle * 3 + 0.7)) ** 1.6;
      out[i] = bass[i] * (0.55 + gust * 0.9) + air[i] * 0.2 * gust;
    } else {
      const rustle = region === 'pinewood' ? 0.055 : region === 'savanna' ? 0.13 : 0.085;
      out[i] = bass[i] * (0.7 + 0.2 * Math.cos(cycle)) + air[i] * rustle * (0.7 + 0.3 * Math.sin(cycle * 3));
    }
  }
  const call = (start, duration, hz, gain, bend = 0.2) => {
    let phase = 0;
    const count = sec(duration);
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      phase += 2 * Math.PI * hz * (1 + bend * Math.sin(Math.PI * u)) / SR;
      out[sec(start) + i] += Math.sin(phase) * Math.sin(Math.PI * u) ** 2 * gain;
    }
  };
  if (region === 'coast' && !night) { call(1.1, 0.55, 1100, 0.04, -0.3); call(3.8, 0.45, 980, 0.028, -0.24); }
  if (region === 'industry') {
    call(2.1, 0.16, 360, night ? 0.012 : 0.025, 0); // ressonância mecânica amortecida
    call(4.4, 0.24, 540, 0.014, 0);
  }
  if (region === 'country' && !night) {
    for (const start of [0.9, 3.2, 4.7]) { call(start, 0.19, 2200, 0.05); call(start + 0.26, 0.23, 2600, 0.035); }
  }
  if (region === 'pinewood') {
    if (night) { call(1.4, 0.5, 310, 0.042, 0.08); call(2.05, 0.4, 280, 0.03, 0.06); }
    else for (const start of [1, 2.8, 4.5]) { call(start, 0.12, 2900, 0.04); call(start + 0.18, 0.17, 2350, 0.035); }
  }
  if ((night && region === 'country') || region === 'savanna') {
    for (const start of [0.6, 1.8, 3.1, 4.6]) for (let c = 0; c < (region === 'savanna' ? 6 : 3); c++) {
      call(start + c * 0.065, 0.035, region === 'savanna' ? 3100 : 4100, night ? 0.025 : 0.017, 0.025);
    }
    if (region === 'savanna' && !night) call(2.5, 0.32, 1450, 0.035, -0.15);
  }
  if (region === 'desert') {
    // O lamento do vento passando por pedra: duas notas graves, longas e tortas.
    call(1.3, 1.1, night ? 150 : 235, 0.024, 0.28);
    call(4.1, 0.9, night ? 126 : 196, 0.017, -0.22);
  }
  let mean = 0;
  for (const sample of out) mean += sample / n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  writeWav(`${region}_${night ? 'night' : 'day'}.wav`, out, night ? 0.22 : 0.27);
}

// ---- Vento (loop 8s): base grave filtrada + lufadas senoidais, com emenda cruzada ----
function windLoop() {
  seed = 41177;
  const n = sec(8);
  const gusts = forestNoise(n, 0.02);
  const hiss = forestNoise(n, 0.28);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cycle = 2 * Math.PI * i / n;
    // Duas escalas de rajada somadas: a respiração longa e o assopro curto por cima.
    const gust = 0.45 + 0.35 * Math.sin(cycle * 2) + 0.2 * Math.sin(cycle * 5 + 1.3);
    out[i] = gusts[i] * 2.2 * Math.max(0.12, gust) + hiss[i] * 0.5 * Math.max(0, gust - 0.35);
  }
  let mean = 0;
  for (const sample of out) mean += sample / n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  writeWav('wind_loop.wav', out, 0.3);
}

// ---- Trovão: estalo seco e ribombar grave que quebra em ondas até sumir ----
function thunder() {
  seed = 68311;
  const n = sec(3.4);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = rnd();
  const crack = lowpass(raw, 0.45);
  const deep = lowpass(lowpass(lowpass(raw, 0.05), 0.05), 0.018);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i / SR;
    const estalo = Math.exp(-k * 9);
    const rolagem = Math.exp(-k * 1.15)
      * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.7 * k + Math.sin(2 * Math.PI * 0.6 * k)));
    out[i] = crack[i] * estalo * 0.75 + deep[i] * (rolagem + estalo * 0.4) * 2.4;
  }
  const tail = sec(0.25);
  for (let i = 0; i < tail; i++) out[n - tail + i] *= 1 - i / tail;
  writeWav('thunder.wav', out, 0.7);
}

// ---- Tornado (loop 8s): o trem de carga — ronco grave, assopro médio e cascalho ----
function tornadoLoop() {
  seed = 90211;
  const n = sec(8);
  const rumble = lowpass(lowpass(forestNoise(n, 0.06), 0.08), 0.04);
  const mid = forestNoise(n, 0.16);
  const grit = forestNoise(n, 0.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cycle = 2 * Math.PI * i / n;
    // Duas voltas de intensidade por loop: o funil nunca soa igual dois segundos seguidos.
    const surto = 0.5 + 0.3 * Math.sin(cycle * 2) + 0.2 * Math.sin(cycle * 3 + 2.1);
    out[i] = rumble[i] * 3.4 * (0.55 + 0.45 * surto)
      + mid[i] * 1.3 * surto
      + grit[i] * 0.5 * Math.max(0, surto - 0.55);
  }
  let mean = 0;
  for (const sample of out) mean += sample / n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  writeWav('tornado_loop.wav', out, 0.34);
}

// ---- Onda (loop 8s): o mar revolto — swell grave contínuo com crista espumando ----
function waveLoop() {
  seed = 24771;
  const n = sec(8);
  const deep = lowpass(lowpass(forestNoise(n, 0.05), 0.09), 0.03);
  const foam = forestNoise(n, 0.38);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cycle = 2 * Math.PI * i / n;
    // Dois swell por volta: a onda grande e a quebra curta em cima dela.
    const swell = 0.45 + 0.4 * Math.sin(cycle * 2) + 0.15 * Math.sin(cycle * 5 + 0.9);
    out[i] = deep[i] * 3.1 * (0.4 + 0.6 * swell) + foam[i] * 0.9 * Math.max(0, swell - 0.3);
  }
  let mean = 0;
  for (const sample of out) mean += sample / n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  writeWav('wave_loop.wav', out, 0.32);
}

// ---- Cachoeira (loop 8s): água branca — assopro contínuo da folha com o tombo grave na bacia ----
function cascadeLoop() {
  seed = 58271;
  const n = sec(8);
  const deep = lowpass(lowpass(forestNoise(n, 0.05), 0.1), 0.05);
  const sheet = forestNoise(n, 0.22);
  const foam = forestNoise(n, 0.62);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cycle = 2 * Math.PI * i / n;
    // A folha ondula devagar e a espuma pisca por cima: três voltas por loop, ciclo inteiro,
    // para a emenda não deixar corte no meio do barulho.
    const breathe = 0.6 + 0.28 * Math.sin(cycle * 3) + 0.12 * Math.sin(cycle * 7 + 1.7);
    out[i] = deep[i] * 2.5 * (0.5 + 0.5 * breathe)
      + sheet[i] * 1.5 * breathe
      + foam[i] * 0.45 * (0.45 + 0.55 * breathe);
  }
  let mean = 0;
  for (const sample of out) mean += sample / n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  writeWav('cascade_loop.wav', out, 0.3);
}

// ---- Alerta de clima severo: sirene de defesa civil em dois tons ----
function weatherAlert() {
  const out = new Float32Array(sec(2.8));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    // Alterna grave/agudo a cada 0,7s, com vibrato leve para não parecer bipe de UI.
    const tone = Math.floor(t / 0.7) % 2 === 0 ? 430 : 620;
    const freq = tone + 7 * Math.sin(2 * Math.PI * 5.5 * t);
    phase += 2 * Math.PI * freq / SR;
    const edge = Math.min(t / 0.12, (out.length / SR - t) / 0.45, 1);
    const env = Math.max(0, Math.min(1, edge));
    out[i] = (Math.sin(phase) + 0.28 * Math.sin(phase * 2)) * env * env * 0.6;
  }
  oneShot('weather_alert.wav', out, 0.2);
}

// ---- Fronteira: a voz e o peso do gorila ----
//
// O urro é três golfadas, não um uivo contínuo: é assim que um dorsípedio de duas toneladas
// avisa (buf, rosna, bate no peito), e um sintetizado de uma nota só soaria a alarme de carro.
// A fundamental cai de 96 para 62 Hz ao longo de cada golfada porque a garganta desce junto
// com o ar; sobre ela entra a sub-oscilante em metade da frequência, que é o que faz o som ser
// *sentido* no alto-falante pequeno do celular em vez de apenas ouvido, e o ruído passa por um
// filtro que jura ser peito, não serra.
function gorillaRoar() {
  seed = 51_703; // semente própria: `--frontier` e a geração completa têm de dar os mesmos bytes.
  const out = new Float32Array(sec(1.55));
  const gritRaw = new Float32Array(out.length);
  for (let i = 0; i < gritRaw.length; i++) gritRaw[i] = rnd();
  const grit = lowpass(lowpass(gritRaw, 0.055), 0.055);
  for (const [start, dur, forca] of [[0.03, 0.42, 1], [0.52, 0.34, 0.82], [0.92, 0.58, 0.96]]) {
    let phase = 0, sub = 0;
    for (let i = 0; i < sec(dur); i++) {
      const idx = sec(start) + i;
      if (idx >= out.length) break;
      const u = i / (sec(dur) - 1);
      const freq = 96 - 34 * u + 5 * Math.sin(2 * Math.PI * 7.5 * u * dur) + 14 * Math.sin(2 * Math.PI * 1.7 * u);
      phase += 2 * Math.PI * freq / SR;
      sub += Math.PI * freq / SR; // metade da fundamental: o peito que treme o cone.
      const env = Math.sin(Math.PI * u) ** 1.4;
      out[idx] += env * forca * (Math.sin(phase) * 0.62 + Math.sin(sub) * 0.8
        + Math.sin(phase * 2) * 0.2 + Math.sin(phase * 3) * 0.09 + grit[idx] * 0.9);
    }
  }
  oneShot('gorilla_roar.wav', out, 0.62);
}

// O passo não é o `land.wav` do jogador: é um corpo de duas toneladas caindo na serapilheira.
// Sub-grave de 48 Hz que morre em 30 (o chão empurrando o ar), mais o estouro molhado de folha
// seca por baixo, mais um rebote longo e baixo que é a mata respondendo, não a bota.
function gorillaStep() {
  seed = 20_921;
  const out = new Float32Array(sec(0.62));
  const leafRaw = new Float32Array(out.length);
  for (let i = 0; i < leafRaw.length; i++) leafRaw[i] = rnd();
  const leaf = lowpass(leafRaw, 0.28);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase += 2 * Math.PI * (48 - 18 * Math.min(1, t * 6)) / SR;
    const boom = Math.sin(phase) * Math.exp(-t * 9);
    const crunch = leaf[i] * Math.exp(-t * 34) * (t < 0.09 ? 1 : 0.2);
    const rebound = Math.sin(2 * Math.PI * 27 * t) * Math.exp(-Math.max(0, t - 0.05) * 12) * (t > 0.05 ? 1 : 0);
    out[i] = boom * 1.15 + crunch * 1.6 + rebound * 0.5;
  }
  oneShot('gorilla_step.wav', out, 0.72);
}

// A morte do rotor não é um alarme: é uma máquina de 600 kg perdendo o torque que a sustentava.
// O que faz o som ser um helicóptero morrendo é o chop das pás desacelerando — 22 passagens por
// segundo em voo normal caindo em curva exponencial até as pás praticamente pararem — porque a
// taxa de passagem é o relógio da máquina, e o ouvido lê esse relógio como velocidade. O tom
// fundamental segue a mesma curva (310 → 42 Hz), e no lugar de um beipe de entrada entra o
// tranco metálico do libre: um golpe curto de ruído, não uma nota.
function rotorFail() {
  seed = 71_307; // semente própria: `--frontier` e a geração completa têm de dar os mesmos bytes.
  const dur = 1.7;
  const out = new Float32Array(sec(dur));
  const grão = new Float32Array(out.length);
  for (let i = 0; i < grão.length; i++) grão[i] = rnd();
  const aço = lowpass(grão, 0.42); // o estouro seco do metal, sem corpo
  const peito = lowpass(lowpass(grão, 0.08), 0.08); // a fuselagem vibrando com a perda de passo
  let fase = 0, chop = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const u = t / dur;
    const rotação = 22 * Math.exp(-t * 1.9) + 1.6;
    fase += 2 * Math.PI * (42 + 268 * Math.exp(-t * 1.75)) / SR;
    chop += rotação / SR;
    const golpe = Math.exp(-6.5 * (chop % 1));
    const moribunda = Math.min(1, rotação / 22); // o volume É a rotação: sem torque, sem ar
    const treme = 1 + 0.5 * u * Math.sin(2 * Math.PI * (2 + 6 * u) * t);
    out[i] = moribunda * treme * (Math.sin(fase) * 0.5 + Math.sin(fase * 2) * 0.26 * golpe
      + peito[i] * 0.4 + aço[i] * golpe * 0.55 * (t < 0.4 ? 1 : 0.2));
  }
  // O torque some num instante; o resto é inércia. Este é o único clique do arquivo, e ele vem
  // antes das pás, porque é o que o piloto ouve no momento exato em que o manche responde nada.
  for (let i = 0; i < sec(0.1); i++) out[i] += aço[i] * Math.exp(-i * 60 / SR) * 1.5;
  oneShot('rotor_fail.wav', out, 0.6);
}

// O reacender não é um motor de carro pegando: é uma turbina parada recomeçando. Metade do som é
// o arranque engrenando (dentes de ruído que apertam conforme a velocidade sobe), metade é o
// rotor voltando a bater ar — por baixo, ainda fraco, ~6 passagens por segundo, e é essa
// diferença de taxa que diz ao ouvido que a máquina pega mas ainda não voa.
function engineCatch() {
  seed = 33_119;
  const dur = 0.7;
  const out = new Float32Array(sec(dur));
  const grão = new Float32Array(out.length);
  for (let i = 0; i < grão.length; i++) grão[i] = rnd();
  const arranhado = lowpass(lowpass(grão, 0.3), 0.3);
  let fase = 0, chop = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    if (t < 0.44) {
      // Os dentes marcam o aperto do arranque, e a cadência acelera: é o mesmo gesto de quem dá
      // partida repetida num motor molhado, primeiro espaçado, depois quase contínuo.
      const dentes = Math.exp(-9 * ((t * 7) % 1)) + Math.exp(-9 * ((t * 7 + 0.5) % 1));
      const aperto = 0.35 + 0.65 * (t / 0.44);
      out[i] = arranhado[i] * dentes * aperto * 1.1
        + Math.sin(2 * Math.PI * 84 * t) * 0.12 * aperto * (1 - t / 0.44);
    } else {
      const u = (t - 0.44) / 0.26;
      const rotação = 3 + 14 * Math.min(1, u * 1.4);
      chop += rotação / SR;
      const golpe = Math.exp(-5 * (chop % 1)) * Math.min(1, u * 6);
      fase += 2 * Math.PI * (46 + 150 * u) / SR;
      out[i] = Math.sin(fase) * 0.5 * Math.sin(Math.PI * Math.min(1, u))
        + arranhado[i] * golpe * 0.9;
    }
  }
  oneShot('engine_catch.wav', out, 0.5);
}

// ---- Fronteira pelo rio: o aviso e a rotura da superfície ----
//
// A piranha não ruge: ela não tem peito para isso e o jogador está dentro do som, não diante
// dele. O aviso é a superfície deslizando — ruído branco passando por uma fenda que abre e volta
// a fechar, varrida pelo tempo, porque o que faz um som "ir embora pela água" é o filtro se
// movendo, não o volume. Por baixo entram dois pulsos graves de barbatana batendo, espaçados
// como uma respiração, e é só: o resto do medo é o que o jogador já viu na linha da HUD.
function piranhaThreat() {
  seed = 61_977; // semente própria: `--frontier` e a geração completa têm de dar os mesmos bytes.
  const dur = 1.15;
  const out = new Float32Array(sec(dur));
  const grão = new Float32Array(out.length);
  for (let i = 0; i < grão.length; i++) grão[i] = rnd();
  let s = 0;
  for (let i = 0; i < out.length; i++) {
    const u = (i / SR) / dur;
    // A brecha abre até a metade e volta a fechar: é um único gesto contínuo, não dois sons.
    const brecha = 0.05 + 0.55 * Math.sin(Math.PI * Math.min(1, u * 1.1));
    s += (grão[i] - s) * brecha;
    const envelope = Math.sin(Math.PI * u) ** 0.7; // macio na entrada, morrendo na saída
    out[i] = (grão[i] - s) * envelope * 0.85 + s * 0.22;
  }
  for (const [start, freq] of [[0.1, 78], [0.63, 61]]) {
    let fase = 0;
    for (let i = 0; i < sec(0.26); i++) {
      const idx = sec(start) + i;
      if (idx >= out.length) break;
      const tt = i / SR;
      fase += 2 * Math.PI * (freq - 17 * (tt / 0.26)) / SR;
      out[idx] += Math.sin(fase) * Math.exp(-tt * 11) * 0.8;
    }
  }
  oneShot('piranha_threat.wav', out, 0.5);
}

// O corpo rompendo a superfície é o som mais largo do jogo: dois metros de peixe saindo do rio,
// caindo de volta e espirrando. Três camadas, cada uma com uma causa física diferente: o
// estouro cru (ruído quase sem filtro, que é o que se ouve a 20 tiles), a coluna d'água que sobe
// e desaba (um pente com atraso crescente — o atraso *é* a altura da coluna, então o tom cai
// conforme ela desaba, e é isso que diz ao ouvido que aquilo foi grande), e o sub-grave do
// deslocamento de água. Os pingos depois do golpe não são enfeite: sem cauda irregular o som
// seria uma porta batendo molhada, e seria ouvido como um clique só.
function piranhaSplash() {
  seed = 88_511;
  const dur = 0.55;
  const out = new Float32Array(sec(dur));
  const grão = new Float32Array(out.length);
  for (let i = 0; i < grão.length; i++) grão[i] = rnd();
  const água = lowpass(grão, 0.55); // o corpo molhado, sem a aresta do ruído puro
  const pente = new Float32Array(out.length);
  let fase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const env = Math.exp(-t * 15);
    // Atraso de 6,2 ms a 15 ms: o pico do pente desliza de ~160 Hz para ~66 Hz na primeira
    // metade do gesto, que é exatamente o tempo de a coluna cair.
    const atraso = Math.max(1, Math.round(SR * (0.0062 + 0.0088 * Math.min(1, t * 5))));
    const j = i - atraso;
    pente[i] = grão[i] * env * 0.5 + (j >= 0 ? pente[j] : 0) * 0.72;
    fase += 2 * Math.PI * (74 - 36 * Math.min(1, t * 5)) / SR;
    out[i] = grão[i] * env * 0.9 + água[i] * Math.exp(-t * 7) * 0.6
      + pente[i] * 0.5 + Math.sin(fase) * Math.exp(-t * 10) * 0.75;
  }
  // Os pingos: cada um é um estouro de ruído *passo-alto* (o grão menos o seu lowpass), porque
  // gota pequena não tem grave nenhum, e com amplitudes irregulares porque respingo não é metrônomo.
  for (const [atraso, força, vida] of [[0.13, 0.4, 46], [0.185, 0.22, 60], [0.27, 0.33, 52],
    [0.33, 0.16, 70], [0.41, 0.26, 58]]) {
    const inicial = sec(atraso);
    for (let i = 0; i < sec(0.07); i++) {
      const idx = inicial + i;
      if (idx >= out.length) break;
      const tt = i / SR;
      out[idx] += (grão[idx] - água[idx]) * Math.exp(-tt * vida) * força * 1.4;
    }
  }
  oneShot('piranha_splash.wav', out, 0.7);
}

// O grito de guerra humano não é o urro do gorila: o gorila é peito (96→62 Hz) e este é garganta.
// Uma voz aberta em ~230 Hz com as duas primeiras vogais do chamado subindo e a última caindo, e o
// timbre vindo dos harmônicos pesados em 690 Hz e 1150 Hz — que é onde mora o /a/ aberto de um
// grito, não onde mora o zumbido de um motor. O vibrato de 6,5 Hz é o esforço de sustentar a nota
// aos gritos, e o fio de ar por cima (ruído passa-altos, o grão menos o próprio lowpass) é o que
// faz o ouvido ler carne e não sintetizador. Três sílabas com ataque duro porque chamado não tem
// attack time de violino: cada uma começa no talo.
function triboGrito() {
  seed = 39_417; // semente própria: `--tribo` e a geração completa têm de dar os mesmos bytes.
  const dur = 1.15;
  const out = new Float32Array(sec(dur));
  const grão = new Float32Array(out.length);
  for (let i = 0; i < grão.length; i++) grão[i] = rnd();
  const ar = (() => {
    const y = new Float32Array(out.length);
    let lp = 0;
    for (let i = 0; i < out.length; i++) {
      lp += 0.16 * (grão[i] - lp);
      y[i] = grão[i] - lp; // passa-altos: o chiado fica, o corpo vai embora
    }
    return y;
  })();
  for (const [start, sil, pico, cauda] of [[0.02, 0.26, 1, 0.9], [0.3, 0.22, 0.86, 0.78],
    [0.56, 0.55, 0.94, 0.62]]) {
    let fase = 0;
    const n = sec(sil);
    for (let i = 0; i < n; i++) {
      const idx = sec(start) + i;
      if (idx >= out.length) break;
      const u = i / (n - 1);
      // A sílaba final desaba: quem chama alguém perde o fôlego no meio da última palavra.
      const f = pico * (238 + 46 * Math.sin(Math.PI * Math.min(1, u * 1.35)) - 58 * u * u);
      fase += 2 * Math.PI * f / SR;
      const vib = 1 + 0.022 * Math.sin(2 * Math.PI * 6.5 * u * sil);
      const env = Math.min(1, u * 14) * (1 - u) ** 0.85;
      const harm = Math.sin(fase * vib) * 0.5 + Math.sin(fase * 2 * vib) * 0.24
        + Math.sin(fase * 3 * vib) * 0.3 + Math.sin(fase * 5 * vib) * 0.26
        + Math.sin(fase * 7 * vib) * 0.11;
      out[idx] += env * cauda * (harm + ar[idx] * (0.22 + 0.2 * u));
    }
  }
  oneShot('tribo_grito.wav', out, 0.6);
}

// O tambor do acampamento é ouvido a 45 tiles, então o que importa não é o ataque: é o corpo.
// Cada batida é a membrana caindo de 142 Hz para 62 em sessenta milissegundos (o tempo que o ar
// dentro do casco leva para empurrar a pele de volta), o taco da mão no aro (passa-altos que morre
// em 15 ms), e o casco em 55 Hz que continua soando depois de a membrana ter parado. As quatro
// batidas não são um metrônomo: a terceira é mais fraca e a última vem atrasada de propósito,
// porque um tambor tocado por alguém que está do outro lado da clareia não é programado.
function triboTambor() {
  seed = 62_215;
  const dur = 1.6;
  const out = new Float32Array(sec(dur));
  const grão = new Float32Array(out.length);
  for (let i = 0; i < grão.length; i++) grão[i] = rnd();
  const slap = (() => {
    const y = new Float32Array(out.length);
    let lp = 0;
    for (let i = 0; i < out.length; i++) {
      lp += 0.3 * (grão[i] - lp);
      y[i] = grão[i] - lp;
    }
    return y;
  })();
  for (const [start, força, vida] of [[0.0, 1, 20], [0.21, 0.82, 22], [0.4, 0.55, 26],
    [0.67, 0.9, 18]]) {
    let fase = 0, casco = 0;
    const base = sec(start);
    for (let i = base; i < out.length; i++) {
      const tt = (i - base) / SR;
      const f = 62 + 80 * Math.exp(-tt * 26);
      fase += 2 * Math.PI * f / SR;
      casco += 2 * Math.PI * 55 / SR;
      const membrana = Math.sin(fase) * Math.exp(-tt * vida);
      const madeira = Math.sin(casco) * Math.exp(-tt * 7) * 0.42;
      const mão = slap[i] * Math.exp(-tt * 210) * 1.5;
      out[i] += (membrana * 1.1 + madeira + mão) * força;
    }
  }
  oneShot('tribo_tambor.wav', out, 0.68);
}

fs.mkdirSync(OUT, { recursive: true });
// Cada categoria só roda quando não foi pedida uma outra específica:
// sem flag gera tudo, `--weather` gera só o clima, `--weapons --weather` gera as duas.
const CATS = ['base', 'weapons', 'exploration', 'regions', 'weather', 'hazards', 'frontier',
  'tribo'];
const FLAGS = {
  base: '--base', weapons: '--weapons', exploration: '--exploration',
  regions: '--regions', weather: '--weather', hazards: '--hazards',
  frontier: '--frontier', tribo: '--tribo',
};
const asked = CATS.filter((cat) => process.argv.includes(FLAGS[cat]));
const skips = (cat) => asked.length > 0 && !asked.includes(cat);
if (!skips('base')) {
  siren();
  engine();
  heliRotor();
  explosion();
  punch();
  nightAmbience();
}
if (!skips('weapons')) {
  gunshot('pistol_shot.wav', 140, 26);
  gunshot('revolver_shot.wav', 118, 21);
  gunshot('smg_shot.wav', 200, 40);
  gunshot('micro_shot.wav', 240, 52);
  gunshot('rifle_shot.wav', 96, 19);
  gunshot('sniper_shot.wav', 84, 11);
  shotgunBlast('shotgun_blast.wav');
  batSwing('bat_swing.wav');
  batHit('bat_hit.wav');
  gunMechanism('weapon_reload.wav', [0, 0.14, 0.37, 0.46], 0.55);
  gunMechanism('weapon_empty.wav', [0], 0.08);
}
if (!skips('exploration')) {
  // Independente das armas: --exploration e geração completa produzem os mesmos WAVs.
  seed = 73129;
  jump();
  land();
  vault();
  death();
  carHorn();
  animalCall();
  forestAmbience(false);
  forestAmbience(true);
}
if (!skips('regions')) {
  for (const region of ['coast', 'industry', 'country', 'pinewood', 'savanna', 'desert']) {
    regionAmbience(region, false);
    regionAmbience(region, true);
  }
}
if (!skips('weather')) {
  windLoop();
  thunder();
}
if (!skips('hazards')) {
  tornadoLoop();
  waveLoop();
  cascadeLoop();
  weatherAlert();
}
if (!skips('frontier')) {
  gorillaRoar();
  gorillaStep();
  rotorFail();
  engineCatch();
  piranhaThreat();
  piranhaSplash();
}
if (!skips('tribo')) {
  triboGrito();
  triboTambor();
}
console.log('OK →', OUT);
