"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AmbientSystem = void 0;
exports.selectAmbient = selectAmbient;
function selectAmbient(context) {
    if (!context.outdoors)
        return null;
    const t = Number.isFinite(context.timeOfDay) ? ((context.timeOfDay % 1) + 1) % 1 : 0.5;
    const night = t < 0.245 || t > 0.797;
    switch (context.biome) {
        case 'beach':
        case 'docks': return night ? 'coastNight' : 'coastDay';
        case 'industrial': return night ? 'industryNight' : 'industryDay';
        case 'forest':
        case 'park': return night ? 'forestNight' : 'forestDay';
        case 'countryside': return night ? 'countryNight' : 'countryDay';
        case 'pinewood': return night ? 'pinewoodNight' : 'pinewoodDay';
        case 'savanna': return night ? 'savannaNight' : 'savannaDay';
        case 'desert': return night ? 'desertNight' : 'desertDay';
        default: return night ? 'cityNight' : 'cityDay';
    }
}
/** Explicit simulation context + injected sound manager. No global GameState, native imports or timers.
 * At most two ambient voices: fade-out/switch/fade-in regional bed plus independent rain.
 * SoundManager retains ownership of unlock, mute, focus loss and native resource cleanup.
 */
class AmbientSystem {
    constructor(output) {
        this.output = output;
        this.current = null;
        this.candidate = null;
        this.stableFor = 0;
        this.volume = 0;
        this.rainVolume = 0;
        this.snow = false;
        this.hazardBed = null;
        this.hazardVolume = 0;
        this.sentVolume = -1;
        this.sentRain = -1;
        this.sentBed = 'rain';
    }
    update(dt, context) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        dt = Math.min(dt, 0.25);
        this.snow = !!context.snow;
        this.hazardBed = context.hazardBed ?? null;
        this.hazardVolume = Number.isFinite(context.hazardVolume)
            ? Math.max(0, Math.min(1, context.hazardVolume))
            : 0;
        const next = selectAmbient(context);
        if (next !== this.candidate) {
            this.candidate = next;
            this.stableFor = 0;
        }
        else
            this.stableFor += dt;
        if (!context.outdoors) {
            this.current = null;
            this.volume = this.rainVolume = this.hazardVolume = 0;
            this.publish();
            return;
        }
        if (!this.current)
            this.current = next;
        const switching = next !== this.current && this.stableFor >= 1.2;
        const wet = Number.isFinite(context.rain) ? Math.max(0, Math.min(1, context.rain)) : 0;
        const target = switching ? 0 : 0.48 * (1 - wet * 0.35);
        this.volume += Math.max(-dt * 0.7, Math.min(dt * 0.7, target - this.volume));
        if (switching && this.volume <= 0.001) {
            this.current = next;
            this.volume = 0;
        }
        const rainTarget = wet < 0.025 ? 0 : wet * (this.snow ? 0.4 : 0.58);
        this.rainVolume += Math.max(-dt * 0.4, Math.min(dt * 0.4, rainTarget - this.rainVolume));
        this.publish();
    }
    /**
     * Menu/pause: the simulation is frozen, so no bed may keep running on its own.
     * Forgets what was published; the next update re-arms the region and rain from scratch.
     */
    suspend() {
        this.current = null;
        this.candidate = null;
        this.stableFor = 0;
        this.volume = this.rainVolume = this.hazardVolume = 0;
        this.hazardBed = null;
        this.sentKey = undefined;
        this.sentVolume = -1;
        this.sentRain = -1;
        this.publish();
    }
    publish() {
        // Quantized requests avoid flooding the async native channel with per-frame volume changes.
        const volume = Math.round(this.volume * 50) / 50;
        // Um só leito de tempo por quadro: o perigo severo abafa a chuva, não toca junto dela.
        const bed = this.hazardBed ?? (this.snow ? 'wind' : 'rain');
        const wet = Math.round((this.hazardBed ? this.hazardVolume : this.rainVolume) * 50) / 50;
        if (this.sentKey !== this.current || this.sentVolume !== volume) {
            this.output.ambient(this.current, volume);
            this.sentKey = this.current;
            this.sentVolume = volume;
        }
        if (this.sentRain !== wet || this.sentBed !== bed) {
            this.output.weather(wet, bed);
            this.sentRain = wet;
            this.sentBed = bed;
        }
    }
}
exports.AmbientSystem = AmbientSystem;
