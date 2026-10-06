"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sound = void 0;
const expo_asset_1 = require("expo-asset");
// O barril `expo-av` emite um console.warn de deprecação ainda na importação. No aparelho
// esse aviso cai no LogBox, que chama NativeLogBox.show() — e é justamente aí que o boot
// morre ("show is not a function"). Pelos submódulos de áudio o aviso nunca existe.
const Audio = __importStar(require("expo-av/build/Audio"));
const Audio_types_1 = require("expo-av/build/Audio.types");
const sounds_1 = require("./sounds");
// Cache assets, never native Sound players: unloaded Android players cannot be reused.
const MAX_LIVE_SFX = 5;
const liveSfx = new Set();
const lastPlayAt = new Map();
let sfxGeneration = 0;
let pendingAmbient = 'cityDay';
let pendingAmbientVol = 0.42;
let ambientEnabled = false;
let muted = false;
let active = true;
let unlocked = false;
let sessionReady = null;
let unlockPromise = null;
function loopState(sources) {
    return {
        sources, sound: null, activeKey: null, desiredKey: null,
        volume: 0, appliedVolume: 0, generation: 0, dirty: false, task: null,
    };
}
const ambientChannel = loopState(sounds_1.AMBIENT);
const weatherChannel = loopState({
    rain: sounds_1.AMBIENT.rain,
    wind: sounds_1.AMBIENT.wind,
    tornado: sounds_1.AMBIENT.tornado,
    wave: sounds_1.AMBIENT.wave,
});
const loopChannels = {
    engine: loopState(sounds_1.LOOPS),
    siren: loopState(sounds_1.LOOPS),
    cascade: loopState(sounds_1.LOOPS),
    rotor: loopState(sounds_1.LOOPS),
    ar: loopState(sounds_1.LOOPS),
};
function clampVolume(volume) {
    return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
}
function pick(src) {
    return Array.isArray(src) ? src[Math.floor(Math.random() * src.length)] : src;
}
function sourceFor(src) {
    const asset = expo_asset_1.Asset.fromModule(src);
    return { uri: asset.localUri ?? asset.uri };
}
async function ensureSession() {
    if (!sessionReady) {
        sessionReady = (async () => {
            await Audio.setIsEnabledAsync(true);
            await Audio.setAudioModeAsync({
                allowsRecordingIOS: false,
                playsInSilentModeIOS: true,
                staysActiveInBackground: false,
                interruptionModeIOS: Audio_types_1.InterruptionModeIOS.MixWithOthers,
                interruptionModeAndroid: Audio_types_1.InterruptionModeAndroid.DuckOthers,
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
async function dispose(s) {
    try {
        s.setOnPlaybackStatusUpdate(null);
    }
    catch { /* already released */ }
    try {
        await s.stopAsync();
    }
    catch { /* still attempt unload */ }
    try {
        await s.unloadAsync();
    }
    catch { /* already released */ }
}
async function clearLoop(st) {
    const s = st.sound;
    st.sound = null;
    st.activeKey = null;
    if (s)
        await dispose(s);
}
async function syncLoop(st) {
    const key = st.desiredKey;
    const generation = st.generation;
    const current = () => active && !muted && unlocked && st.generation === generation && st.desiredKey === key;
    if (!key || !current()) {
        await clearLoop(st);
        return;
    }
    if (st.sound && st.activeKey !== key)
        await clearLoop(st);
    await ensureSession();
    if (!current())
        return;
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
    if (!status.isLoaded)
        throw new Error('Loop player is not loaded');
    while (current() && st.appliedVolume !== st.volume) {
        const volume = st.volume;
        await s.setVolumeAsync(volume);
        st.appliedVolume = volume;
    }
    if (current() && !status.isPlaying)
        await s.playAsync();
    if (!current())
        await clearLoop(st);
}
function reconcileLoop(st) {
    st.dirty = true;
    if (!st.task) {
        st.task = (async () => {
            while (st.dirty) {
                st.dirty = false;
                const generation = st.generation;
                try {
                    await syncLoop(st);
                }
                catch (err) {
                    await clearLoop(st);
                    if (active && generation === st.generation)
                        console.warn('[audio] loop failed', err);
                }
            }
        })().finally(() => {
            st.task = null;
            if (st.dirty)
                void reconcileLoop(st);
        });
    }
    return st.task;
}
function requestLoop(st, key, volume) {
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
        ...Object.values(loopChannels).map((st) => reconcileLoop(st)),
    ]);
}
function finishSfx(playback) {
    if (playback.finished)
        return;
    playback.finished = true;
    if (playback.timer !== null)
        clearTimeout(playback.timer);
    playback.timer = null;
    // Status callbacks can fire inside playAsync; unload only after that operation settles.
    void playback.task?.then(async () => {
        const s = playback.sound;
        playback.sound = null;
        if (s)
            await dispose(s);
        liveSfx.delete(playback);
        playback.task = null;
    });
}
function playOneShot(src, volume, throttleKey, minGapMs = 0) {
    if (!active || muted || liveSfx.size >= MAX_LIVE_SFX)
        return Promise.resolve();
    if (throttleKey && minGapMs > 0) {
        const now = Date.now();
        const prev = lastPlayAt.get(throttleKey) ?? 0;
        if (now - prev < minGapMs)
            return Promise.resolve();
        lastPlayAt.set(throttleKey, now);
    }
    const playback = { sound: null, timer: null, finished: false, task: null };
    liveSfx.add(playback);
    playback.task = (async () => {
        try {
            await ensureSession();
            if (playback.finished)
                return;
            const { sound: s } = await Audio.Sound.createAsync(sourceFor(src), {
                shouldPlay: false,
                volume: clampVolume(volume),
                isLooping: false,
            });
            playback.sound = s;
            if (playback.finished)
                return;
            playback.timer = setTimeout(() => finishSfx(playback), 3500);
            s.setOnPlaybackStatusUpdate((status) => {
                if (!status.isLoaded || status.didJustFinish)
                    finishSfx(playback);
            });
            if (!playback.finished)
                await s.playAsync();
        }
        catch (err) {
            const cancelled = playback.finished;
            finishSfx(playback);
            if (active && !cancelled)
                console.warn('[audio] play failed', err);
        }
    })();
    return playback.task;
}
exports.sound = {
    init() {
        if (active)
            void ensureSession().catch((err) => console.warn('[audio] session failed', err));
    },
    async unlock() {
        if (!active)
            return;
        if (unlockPromise)
            return unlockPromise;
        if (unlocked) {
            await refreshLoops();
            return;
        }
        const generation = sfxGeneration;
        unlockPromise = (async () => {
            await ensureSession();
            if (!active || generation !== sfxGeneration)
                return;
            unlocked = true;
            await playOneShot(pick(sounds_1.SFX.uiSwitch), 0.95);
            await refreshLoops();
        })().catch((err) => {
            console.warn('[audio] unlock failed', err);
        }).finally(() => {
            unlockPromise = null;
        });
        return unlockPromise;
    },
    play(key, volume = 1) {
        if (!active || muted)
            return;
        const throttle = key.startsWith('step')
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
                void playOneShot(pick(sounds_1.SFX[key]), volume, throttle?.k, throttle?.gap ?? 0);
            }
        };
        if (!unlocked) {
            void this.unlock().then(go);
            return;
        }
        go();
    },
    ambient(key, volume = 0.5) {
        ambientEnabled = key !== null;
        if (key) {
            pendingAmbient = key;
            pendingAmbientVol = clampVolume(volume);
        }
        void refreshAmbient();
    },
    /** Leito independente do clima; volume zero libera o player nativo em vez de rodar mudo. */
    weather(volume, bed) {
        const gain = clampVolume(volume);
        void requestLoop(weatherChannel, gain > 0 ? bed : null, gain);
    },
    /** Leito do casco em voo: o corte das pás e o sopro do ar, cada um no seu canal. */
    rotorLoop(volume) {
        const gain = clampVolume(volume);
        void requestLoop(loopChannels.rotor, gain > 0 ? 'rotor' : null, gain);
    },
    arLoop(volume) {
        const gain = clampVolume(volume);
        void requestLoop(loopChannels.ar, gain > 0 ? 'ar' : null, gain);
    },
    setLoop(ch, key, volume = 0.5) {
        void requestLoop(loopChannels[ch], key, volume);
    },
    stopLoops() {
        for (const ch of Object.keys(loopChannels)) {
            void requestLoop(loopChannels[ch], null, 0);
        }
    },
    resumeAmbient() {
        if (!active || muted || !ambientEnabled)
            return;
        if (!unlocked) {
            void this.unlock();
            return;
        }
        void refreshAmbient();
    },
    setActive(value) {
        if (active === value)
            return;
        active = value;
        sfxGeneration += 1;
        if (!active)
            for (const playback of liveSfx)
                finishSfx(playback);
        ambientChannel.generation += 1;
        weatherChannel.generation += 1;
        for (const st of Object.values(loopChannels))
            st.generation += 1;
        void refreshLoops();
    },
    setMuted(m) {
        if (muted === m)
            return;
        muted = m;
        if (m) {
            sfxGeneration += 1;
            for (const playback of liveSfx)
                finishSfx(playback);
        }
        ambientChannel.generation += 1;
        weatherChannel.generation += 1;
        for (const st of Object.values(loopChannels))
            st.generation += 1;
        void refreshLoops();
    },
    get muted() {
        return muted;
    },
    get isUnlocked() {
        return unlocked;
    },
};
