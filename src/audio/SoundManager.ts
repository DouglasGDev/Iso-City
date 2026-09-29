import { Asset } from 'expo-asset';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import {
  AMBIENT,
  LOOPS,
  SFX,
  type AmbientKey,
  type LoopChannel,
  type LoopKey,
  type SfxKey,
  type WeatherBed,
} from './sounds';

type SoundSource = Parameters<typeof Asset.fromModule>[0];
type AvSound = InstanceType<typeof Audio.Sound>;

// Cache assets, never native Sound players: unloaded Android players cannot be reused.
const MAX_LIVE_SFX = 5;
interface SfxPlayback {
  sound: AvSound | null;
  timer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
  task: Promise<void> | null;
}
const liveSfx = new Set<SfxPlayback>();
const lastPlayAt = new Map<string, number>();
let sfxGeneration = 0;

let pendingAmbient: AmbientKey = 'cityDay';
let pendingAmbientVol = 0.42;
let ambientEnabled = false;
let muted = false;
let active = true;
let unlocked = false;
let sessionReady: Promise<void> | null = null;
let unlockPromise: Promise<void> | null = null;

interface LoopState<K extends string> {
  sources: Record<K, SoundSource>;
  sound: AvSound | null;
  activeKey: K | null;
  desiredKey: K | null;
  volume: number;
  appliedVolume: number;
  generation: number;
  dirty: boolean;
  task: Promise<void> | null;
}

function loopState<K extends string>(sources: Record<K, SoundSource>): LoopState<K> {
  return {
    sources, sound: null, activeKey: null, desiredKey: null,
    volume: 0, appliedVolume: 0, generation: 0, dirty: false, task: null,
  };
}

const ambientChannel = loopState<AmbientKey>(AMBIENT);
const weatherChannel = loopState<WeatherBed>({
  rain: AMBIENT.rain,
  wind: AMBIENT.wind,
  tornado: AMBIENT.tornado,
  wave: AMBIENT.wave,
});
const loopChannels: Record<LoopChannel, LoopState<LoopKey>> = {
  engine: loopState<LoopKey>(LOOPS),
  siren: loopState<LoopKey>(LOOPS),
};

function clampVolume(volume: number) {
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
}

function pick(src: SoundSource | readonly SoundSource[]): SoundSource {
  return Array.isArray(src) ? src[Math.floor(Math.random() * src.length)] : src as SoundSource;
}

function sourceFor(src: SoundSource) {
  const asset = Asset.fromModule(src);
  return { uri: asset.localUri ?? asset.uri };
}

async function ensureSession(): Promise<void> {
  if (!sessionReady) {
    sessionReady = (async () => {
      await Audio.setIsEnabledAsync(true);
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
        interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    })().catch((err) => {
      sessionReady = null;
      throw err;
    });
  }
  await sessionReady;
}

async function dispose(s: AvSound) {
  try { s.setOnPlaybackStatusUpdate(null); } catch { /* already released */ }
  try { await s.stopAsync(); } catch { /* still attempt unload */ }
  try { await s.unloadAsync(); } catch { /* already released */ }
}

async function clearLoop<K extends string>(st: LoopState<K>) {
  const s = st.sound;
  st.sound = null;
  st.activeKey = null;
  if (s) await dispose(s);
}

async function syncLoop<K extends string>(st: LoopState<K>) {
  const key = st.desiredKey;
  const generation = st.generation;
  const current = () => active && !muted && unlocked && st.generation === generation && st.desiredKey === key;
  if (!key || !current()) {
    await clearLoop(st);
    return;
  }
  if (st.sound && st.activeKey !== key) await clearLoop(st);
  await ensureSession();
  if (!current()) return;

  if (!st.sound) {
    const volume = st.volume;
    const { sound: s } = await Audio.Sound.createAsync(sourceFor(st.sources[key]), {
      shouldPlay: false,
      isLooping: true,
      volume,
    });
    st.sound = s;
    st.activeKey = key;
    st.appliedVolume = volume;
  }
  if (!current()) {
    await clearLoop(st);
    return;
  }

  const s = st.sound;
  const status = await s.getStatusAsync();
  if (!status.isLoaded) throw new Error('Loop player is not loaded');
  while (current() && st.appliedVolume !== st.volume) {
    const volume = st.volume;
    await s.setVolumeAsync(volume);
    st.appliedVolume = volume;
  }
  if (current() && !status.isPlaying) await s.playAsync();
  if (!current()) await clearLoop(st);
}

function reconcileLoop<K extends string>(st: LoopState<K>): Promise<void> {
  st.dirty = true;
  if (!st.task) {
    st.task = (async () => {
      while (st.dirty) {
        st.dirty = false;
        const generation = st.generation;
        try {
          await syncLoop(st);
        } catch (err) {
          await clearLoop(st);
          if (active && generation === st.generation) console.warn('[audio] loop failed', err);
        }
      }
    })().finally(() => {
      st.task = null;
      if (st.dirty) void reconcileLoop(st);
    });
  }
  return st.task;
}

function requestLoop<K extends string>(st: LoopState<K>, key: K | null, volume: number) {
  if (st.desiredKey !== key) {
    st.desiredKey = key;
    st.generation += 1;
  }
  st.volume = clampVolume(volume);
  return reconcileLoop(st);
}

function refreshAmbient() {
  return requestLoop(ambientChannel, ambientEnabled ? pendingAmbient : null, pendingAmbientVol);
}

function refreshLoops() {
  return Promise.all([
    refreshAmbient(),
    reconcileLoop(weatherChannel),
    reconcileLoop(loopChannels.engine),
    reconcileLoop(loopChannels.siren),
  ]);
}

function finishSfx(playback: SfxPlayback) {
  if (playback.finished) return;
  playback.finished = true;
  if (playback.timer !== null) clearTimeout(playback.timer);
  playback.timer = null;
  // Status callbacks can fire inside playAsync; unload only after that operation settles.
  void playback.task?.then(async () => {
    const s = playback.sound;
    playback.sound = null;
    if (s) await dispose(s);
    liveSfx.delete(playback);
    playback.task = null;
  });
}

function playOneShot(src: SoundSource, volume: number, throttleKey?: string, minGapMs = 0): Promise<void> {
  if (!active || muted || liveSfx.size >= MAX_LIVE_SFX) return Promise.resolve();
  if (throttleKey && minGapMs > 0) {
    const now = Date.now();
    const prev = lastPlayAt.get(throttleKey) ?? 0;
    if (now - prev < minGapMs) return Promise.resolve();
    lastPlayAt.set(throttleKey, now);
  }

  const playback: SfxPlayback = { sound: null, timer: null, finished: false, task: null };
  liveSfx.add(playback);
  playback.task = (async () => {
    try {
      await ensureSession();
      if (playback.finished) return;
      const { sound: s } = await Audio.Sound.createAsync(sourceFor(src), {
        shouldPlay: false,
        volume: clampVolume(volume),
        isLooping: false,
      });
      playback.sound = s;
      if (playback.finished) return;
      playback.timer = setTimeout(() => finishSfx(playback), 3500);
      s.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded || status.didJustFinish) finishSfx(playback);
      });
      if (!playback.finished) await s.playAsync();
    } catch (err) {
      const cancelled = playback.finished;
      finishSfx(playback);
      if (active && !cancelled) console.warn('[audio] play failed', err);
    }
  })();
  return playback.task;
}

export const sound = {
  init() {
    if (active) void ensureSession().catch((err) => console.warn('[audio] session failed', err));
  },

  async unlock() {
    if (!active) return;
    if (unlockPromise) return unlockPromise;
    if (unlocked) {
      await refreshLoops();
      return;
    }
    const generation = sfxGeneration;
    unlockPromise = (async () => {
      await ensureSession();
      if (!active || generation !== sfxGeneration) return;
      unlocked = true;
      await playOneShot(pick(SFX.uiSwitch), 0.95);
      await refreshLoops();
    })().catch((err) => {
      console.warn('[audio] unlock failed', err);
    }).finally(() => {
      unlockPromise = null;
    });
    return unlockPromise;
  },

  play(key: SfxKey, volume = 1) {
    if (!active || muted) return;
    const throttle =
      key.startsWith('step')
        ? { k: key, gap: 140 }
        : key === 'animalCall' || key === 'carHorn'
          // Vizinhança inteira vocaliza no mesmo frame: um único canal por fonte.
          ? { k: key, gap: key === 'animalCall' ? 1200 : 400 }
          : key === 'heliRotor'
            // Loop de 1s emendado como one-shot; um só aparelho audível por vez.
            ? { k: key, gap: 820 }
            : key === 'uiClick' || key === 'uiSwitch'
            ? { k: key, gap: 80 }
            : null;
    const generation = sfxGeneration;
    const go = () => {
      if (unlocked && generation === sfxGeneration) {
        void playOneShot(pick(SFX[key]), volume, throttle?.k, throttle?.gap ?? 0);
      }
    };
    if (!unlocked) {
      void this.unlock().then(go);
      return;
    }
    go();
  },

  ambient(key: AmbientKey | null, volume = 0.5) {
    ambientEnabled = key !== null;
    if (key) {
      pendingAmbient = key;
      pendingAmbientVol = clampVolume(volume);
    }
    void refreshAmbient();
  },

  /** Leito independente do clima; volume zero libera o player nativo em vez de rodar mudo. */
  weather(volume: number, bed: WeatherBed) {
    const gain = clampVolume(volume);
    void requestLoop(weatherChannel, gain > 0 ? bed : null, gain);
  },

  setLoop(ch: LoopChannel, key: LoopKey | null, volume = 0.5) {
    void requestLoop(loopChannels[ch], key, volume);
  },

  stopLoops() {
    for (const ch of ['engine', 'siren'] as const) {
      void requestLoop(loopChannels[ch], null, 0);
    }
  },

  resumeAmbient() {
    if (!active || muted || !ambientEnabled) return;
    if (!unlocked) {
      void this.unlock();
      return;
    }
    void refreshAmbient();
  },

  setActive(value: boolean) {
    if (active === value) return;
    active = value;
    sfxGeneration += 1;
    if (!active) for (const playback of liveSfx) finishSfx(playback);
    ambientChannel.generation += 1;
    weatherChannel.generation += 1;
    for (const st of Object.values(loopChannels)) st.generation += 1;
    void refreshLoops();
  },

  setMuted(m: boolean) {
    if (muted === m) return;
    muted = m;
    if (m) {
      sfxGeneration += 1;
      for (const playback of liveSfx) finishSfx(playback);
    }
    ambientChannel.generation += 1;
    weatherChannel.generation += 1;
    for (const st of Object.values(loopChannels)) st.generation += 1;
    void refreshLoops();
  },

  get muted() {
    return muted;
  },

  get isUnlocked() {
    return unlocked;
  },
};
