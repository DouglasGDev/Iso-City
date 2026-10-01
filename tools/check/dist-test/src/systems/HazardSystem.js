"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HazardSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const Animal_1 = require("../entities/Animal");
const NAME = { tornado: 'TORNADO', hurricane: 'FURACÃO', tsunami: 'TSUNAMI' };
const WATCH_TEXT = {
    tornado: 'tornado se formando',
    hurricane: 'furacão se aproximando',
    tsunami: 'tsunami na costa',
};
const ORDER = ['tornado', 'hurricane', 'tsunami'];
/** Peso do sorteio entre os perigos que o clima e a estação permitem agora. */
const WEIGHTS = [0.45, 0.35, 0.2];
/** Costa é onde a onda pode subir: areia e cais. */
const COAST_BIOMES = ['beach', 'docks'];
/** Linha/coluna com esta água ou mais é mar de verdade, não lago de parque. */
const WIDE_WATER_TILES = 40;
const ease = (from, to, step) => from < to ? Math.min(to, from + step) : Math.max(to, from - step);
const pick = (rng, range) => range[0] + rng() * (range[1] - range[0]);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/**
 * Clima severo: tornado (funil que anda pelo mapa), furacão (olho que cruza o mapa com um
 * campo de vento em volta) e tsunami (frente de onda que sobe a costa). É uma camada por
 * cima das frentes normais: o WeatherSystem escolhe o tempo, aqui entra o perigo que aquele
 * tempo permite. Nenhum dos três alcança além do que a tela pode mostrar — o que empurra o
 * player está, por contrato, onde ele consegue ver. Não conhece o GameState — recebe clima,
 * terreno e entidades por contexto.
 */
class HazardSystem {
    constructor() {
        this.kind = null;
        this.phase = 'calm';
        /** 0..1 força do perigo: governa raio, dano, neblina e volume do leito. */
        this.strength = 0;
        /** Umidade extra que a névoa e o áudio somam ao clima normal. */
        this.wet = 0;
        /** Céu que o perigo fecha além das nuvens da frente. */
        this.dark = 0;
        /** Extra de inclinação da chuva na tela: o furacão deita a água. */
        this.slant = 0;
        /** Funil em tiles do mundo; o raio só cresce enquanto há tornado. */
        this.vortex = { x: 0, y: 0, radius: 0, spin: 0 };
        /**
         * Olho do furacão, em tiles do mundo, e o raio do campo de vento. É o único furacão
         * que existe: o que a tela mostra é o que empurra, e fora deste círculo o tempo é só
         * chuva. `radius` sai de `derive()` — nunca é um número solto.
         */
        this.storm = { x: 0, y: 0, radius: 0, spin: 0 };
        /** A onda avança de `from` até `edge` no eixo `axis`, varrendo o trecho [u0, u1] do outro. */
        this.wave = {
            u0: 0, u1: 0, from: 0, edge: 0, dir: 1, reach: 0, axis: 'y',
        };
        /**
         * O primeiro perigo do jogo só pode nascer depois da janela de graça. É o avesso do
         * cooldown: sortear em 75s fazia o reload cair em cima de um funil.
         */
        this.cooldown = GameConfig_1.GAME_CONFIG.HAZARD_GRACE_S;
        this.watchLeft = 0;
        this.left = 0;
        this.fadeLeft = 0;
        this.elapsed = 0;
        this.heading = 0;
        this.gust = 0;
        this.windX = 1;
        this.windY = 0;
        this.camX = 120;
        this.camY = 120;
        /**
         * Todo sorteio do perigo passa por `rnd()`. Um NaN que entrasse direto virava rumo NaN,
         * olho NaN e molhava wet/dark/slant para sempre — o clima não recupera sozinho.
         */
        this.rawRng = Math.random;
        this.rnd = () => {
            const v = this.rawRng();
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
        };
        this.terrain = null;
    }
    /** Texto de alerta da HUD: null quando o tempo está só ruim, sem perigo. */
    get alert() {
        if (!this.kind || this.phase === 'calm')
            return null;
        return this.phase === 'watch' ? `AVISO · ${WATCH_TEXT[this.kind]}` : `PERIGO · ${NAME[this.kind]}`;
    }
    /**
     * Leito de áudio do perigo; null = o clima normal manda no canal do tempo.
     * O furacão não tem leito próprio: ele é a própria chuva pesada, que já está tocando.
     */
    get bed() {
        if (this.phase === 'calm' || this.strength < 0.08)
            return null;
        if (this.kind === 'tsunami')
            return 'wave';
        return this.kind === 'tornado' ? 'tornado' : null;
    }
    get bedVolume() {
        if (!this.bed)
            return 0;
        const peak = this.kind === 'tsunami' ? 0.85 : this.gust;
        return clamp01(this.strength * (0.45 + 0.55 * peak));
    }
    update(dt, rng, ctx) {
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        this.rawRng = rng;
        // Câmera nanada (metragem do canvas ainda não medida) entraria na conta de proximidade
        // do olho e fecharia o céu para sempre.
        this.camX = Number.isFinite(ctx.camera.x) ? ctx.camera.x : this.camX;
        this.camY = Number.isFinite(ctx.camera.y) ? ctx.camera.y : this.camY;
        this.terrain = ctx.terrain;
        // As rajadas vêm do relógio do próprio evento: o vento do furacão nunca para, ele oscila.
        if (this.phase !== 'calm')
            this.elapsed += dt;
        this.gust = 0.55 + 0.45 * Math.sin(this.elapsed * 0.9);
        if (this.phase === 'calm') {
            this.strength = ease(this.strength, 0, dt / 2);
            this.cooldown -= dt;
            if (this.cooldown <= 0)
                this.consider(this.rnd, ctx);
            this.derive();
            return;
        }
        if (this.kind === 'tornado' && this.phase !== 'fading')
            this.moveVortex(dt, this.rnd, false);
        if (this.kind === 'hurricane')
            this.moveStorm(dt, this.rnd);
        if (this.kind === 'tsunami') {
            this.moveWave(dt, this.phase === 'active' ? 1 : this.phase === 'fading' ? -1 : 0);
        }
        if (this.phase === 'watch') {
            // O aviso toca antes do perigo encostar no chão: dá tempo de buscar cobertura.
            this.strength = ease(this.strength, this.kind === 'hurricane' ? 0.3 : 0, dt / 5);
            this.watchLeft -= dt;
            if (this.watchLeft <= 0) {
                this.phase = 'active';
                const life = this.kind === 'hurricane' ? GameConfig_1.GAME_CONFIG.HURRICANE_LIFE_S
                    : this.kind === 'tsunami' ? GameConfig_1.GAME_CONFIG.TSUNAMI_LIFE_S : GameConfig_1.GAME_CONFIG.TORNADO_LIFE_S;
                this.left = pick(this.rnd, life);
            }
        }
        else if (this.phase === 'active') {
            this.left -= dt;
            this.strength = ease(this.strength, 1, dt / 6);
            if (this.left <= 0) {
                this.phase = 'fading';
                this.fadeLeft = GameConfig_1.GAME_CONFIG.HAZARD_FADE_S;
            }
        }
        else {
            this.strength = ease(this.strength, 0, dt / 3);
            if (this.kind === 'tornado')
                this.moveVortex(dt, this.rnd, true);
            this.fadeLeft -= dt;
            if (this.fadeLeft <= 0 || this.strength <= 0.001)
                this.finish(this.rnd);
        }
        this.derive();
    }
    /** Empurra, arremessa e machuca o que estiver no alcance do perigo. */
    sweep(dt, ctx) {
        if (ctx.indoors || this.strength < 0.04 || !this.kind)
            return;
        const f = { fx: 0, fy: 0, core: false, near: false };
        let killed = false;
        // Quem dirige não é empurrado sozinho: o vento arrasta o carro e a pessoa vai junto.
        const driven = ctx.player.currentVehicleId === null ? null
            : ctx.vehicles.find((v) => v.id === ctx.player.currentVehicleId) ?? null;
        const px = driven ? driven.x : ctx.player.x;
        const py = driven ? driven.y : ctx.player.y;
        this.forceAt(px, py, f);
        if (f.near)
            ctx.shake(this.shakeFor(dt, px, py));
        if (f.core)
            ctx.health.damage(ctx.player, this.coreDamage(dt), ctx.time);
        if (!driven && (f.fx || f.fy))
            this.body(ctx.player, GameConfig_1.GAME_CONFIG.PLAYER_RADIUS, f, dt, 1, ctx);
        for (const npc of ctx.npcs) {
            if (npc.dead || npc.inVehicle)
                continue;
            this.forceAt(npc.x, npc.y, f);
            if (!f.fx && !f.fy)
                continue;
            this.body(npc, GameConfig_1.GAME_CONFIG.NPC_RADIUS, f, dt, 1, ctx);
            if (f.core) {
                this.kill(npc);
                killed = true;
            }
            else if (f.near && (npc.state === 'idle' || npc.state === 'walking')) {
                npc.state = 'fleeing';
                npc.fleeTimer = 5;
            }
        }
        for (const v of ctx.vehicles) {
            if (v.state === 'destroyed')
                continue;
            // Helicóptero voando está fora do alcance do vento no chão.
            if (v.altitude > 0.5)
                continue;
            this.forceAt(v.x, v.y, f);
            if (!f.fx && !f.fy)
                continue;
            this.body(v, GameConfig_1.GAME_CONFIG.VEHICLE_RADIUS, f, dt, 2.4, ctx);
            if (f.core)
                v.health -= 26 * dt * this.strength;
            // O carro do player é a posição dele: arrastou o carro, arrastou quem está dentro.
            if (v === driven) {
                ctx.player.x = v.x;
                ctx.player.y = v.y;
            }
        }
        for (const animal of ctx.animals) {
            if (animal.dead)
                continue;
            this.forceAt(animal.x, animal.y, f);
            if (!f.fx && !f.fy)
                continue;
            this.body(animal, animal.radius, f, dt, 0.85, ctx);
            if (f.core)
                killed = (0, Animal_1.damage)(animal, 200) || killed;
            else if (f.near && animal.state !== 'fleeing') {
                animal.state = 'fleeing';
                animal.fleeTimer = 6;
            }
        }
        if (killed)
            ctx.onStructChange();
    }
    /** Força por unidade de massa num ponto do mundo; false = nenhum perigo alcança. */
    forceAt(x, y, out) {
        out.fx = 0;
        out.fy = 0;
        out.core = false;
        out.near = false;
        if (!this.kind || this.strength <= 0.02)
            return false;
        if (this.kind === 'tornado')
            this.vortexForce(x, y, out);
        else if (this.kind === 'hurricane')
            this.windForce(x, y, out);
        else
            this.waveForce(x, y, out);
        return out.fx !== 0 || out.fy !== 0;
    }
    /** Força um perigo (QA, roteiro, missão): nasce ativo onde a câmera está olhando. */
    force(kind, seconds = 60) {
        this.kind = kind;
        this.phase = 'active';
        this.watchLeft = 0;
        this.fadeLeft = 0;
        this.left = seconds;
        this.elapsed = 0;
        this.strength = 1;
        // Roteiro manda: a onda entra mesmo com a câmera longe do mar.
        this.spawn(kind, () => 0.5, false);
        this.derive();
    }
    consider(rng, ctx) {
        const eligible = [];
        if (!ctx.indoors) {
            // Tornado pede supercélula; furacão pede a chuva longa de verão ou outono.
            if (ctx.weather === 'storm' && (ctx.season === 'primavera' || ctx.season === 'verao')) {
                eligible.push('tornado');
            }
            if ((ctx.weather === 'storm' || ctx.weather === 'rain')
                && (ctx.season === 'verao' || ctx.season === 'outono'))
                eligible.push('hurricane');
            if (this.nearCoast(true))
                eligible.push('tsunami');
        }
        if (!eligible.length) {
            this.cooldown = GameConfig_1.GAME_CONFIG.HAZARD_RETRY_S;
            return;
        }
        // Sorteio ponderado entre os habilitados, com pesos normalizados.
        let total = 0;
        for (const kind of eligible)
            total += WEIGHTS[ORDER.indexOf(kind)];
        let roll = rng() * total;
        let chosen = eligible[eligible.length - 1];
        for (const kind of eligible) {
            const w = WEIGHTS[ORDER.indexOf(kind)];
            if (roll < w) {
                chosen = kind;
                break;
            }
            roll -= w;
        }
        this.begin(chosen, rng, ctx);
    }
    begin(kind, rng, ctx) {
        this.kind = kind;
        this.phase = 'watch';
        this.watchLeft = GameConfig_1.GAME_CONFIG.HAZARD_WATCH_S;
        this.left = 0;
        this.fadeLeft = 0;
        this.elapsed = 0;
        this.strength = 0;
        if (!this.spawn(kind, rng, true)) {
            this.cooldown = GameConfig_1.GAME_CONFIG.HAZARD_RETRY_S;
            this.phase = 'calm';
            this.kind = null;
            return;
        }
        ctx.onAlert(kind);
        this.derive();
    }
    /** Posiciona o perigo; false = não há lugar para ele neste mapa. */
    spawn(kind, rng, strict) {
        if (kind === 'hurricane') {
            this.heading = rng() * Math.PI * 2;
            this.windX = Math.cos(this.heading);
            this.windY = Math.sin(this.heading);
            // O olho entra a barlavento, ainda fora do próprio alcance, e cruza por cima da
            // câmera: o vento só pega quem já está vendo a massa de nuvem chegar. Com `strict`
            // falso (QA e roteiro) ele nasce dentro do campo, para a cena não esperar.
            const d = GameConfig_1.GAME_CONFIG.HURRICANE_REACH_TILES * (strict ? 1.2 : 0.8);
            this.storm.x = this.camX - this.windX * d;
            this.storm.y = this.camY - this.windY * d;
            this.storm.spin = 0;
            return true;
        }
        if (kind === 'tornado') {
            const terrain = this.terrain;
            // Longe o bastante para o aviso aparecer antes de o funil encher a tela.
            // Água vale: o funil que nasce sobre o mar é visto de longe e não trava o sorteio.
            for (let i = 0; i < 12; i++) {
                const a = rng() * Math.PI * 2;
                const d = 20 + rng() * 10;
                const x = this.camX + Math.cos(a) * d;
                const y = this.camY + Math.sin(a) * d;
                const open = !terrain || (terrain.biomeAt(x, y) !== null
                    && x > 6 && y > 6 && x < terrain.worldW - 6 && y < terrain.worldH - 6);
                if (open) {
                    this.vortex.x = x;
                    this.vortex.y = y;
                    this.vortex.radius = GameConfig_1.GAME_CONFIG.TORNADO_RADIUS[0] * 0.4;
                    this.heading = rng() * Math.PI * 2;
                    return true;
                }
            }
            return false;
        }
        const coast = this.nearCoast(strict);
        const t = this.terrain;
        if (!coast || !t)
            return false;
        const half = GameConfig_1.GAME_CONFIG.TSUNAMI_SPAN_TILES / 2;
        // A onda corre perpendicular à faixa de água e varre a praia em volta da câmera.
        const along = coast.axis === 'y' ? this.camX : this.camY;
        const limit = coast.axis === 'y' ? t.worldW : t.worldH;
        const centre = Math.min(Math.max(along, coast.span0 + half), Math.max(coast.span0, coast.span1 - half));
        const u0 = Math.max(1, centre - half);
        const u1 = Math.min(limit - 1, centre + half);
        const mid = (u0 + u1) / 2;
        const land = (water, side) => (coast.axis === 'y'
            ? t.biomeAt(mid, water + side) : t.biomeAt(water + side, mid));
        const low = land(coast.water0, -1);
        const high = land(coast.water1, 1);
        // Sobe pela margem que tem praia/cais; sem praia definida, empurra para dentro do mapa.
        const dir = low && COAST_BIOMES.includes(low) ? -1
            : high && COAST_BIOMES.includes(high) ? 1
                : coast.water0 > limit - coast.water1 ? -1 : 1;
        this.wave.axis = coast.axis;
        this.wave.u0 = u0;
        this.wave.u1 = u1;
        this.wave.from = dir < 0 ? coast.water0 : coast.water1;
        this.wave.edge = this.wave.from;
        this.wave.dir = dir;
        this.wave.reach = 0;
        return true;
    }
    finish(rng) {
        this.phase = 'calm';
        this.kind = null;
        this.strength = 0;
        this.elapsed = 0;
        this.vortex.radius = 0;
        this.storm.spin = 0;
        this.wave.edge = this.wave.from;
        this.wave.reach = 0;
        this.cooldown = pick(rng, GameConfig_1.GAME_CONFIG.HAZARD_COOLDOWN_S);
        this.derive();
    }
    moveVortex(dt, rng, dying) {
        const [min, max] = GameConfig_1.GAME_CONFIG.TORNADO_RADIUS;
        this.vortex.radius = dying
            ? Math.max(0, this.vortex.radius - dt * 1.2)
            : min + (max - min) * this.strength;
        this.vortex.spin += dt * (2.4 + 3.2 * this.strength);
        this.heading += (rng() * 2 - 1) * 0.85 * dt;
        const speed = GameConfig_1.GAME_CONFIG.TORNADO_TRACK_SPEED * (0.55 + 0.45 * this.strength);
        this.vortex.x += Math.cos(this.heading) * speed * dt;
        this.vortex.y += Math.sin(this.heading) * speed * dt;
        this.keepVortexInside();
    }
    /** O funil quica nas bordas do mapa em vez de sair pelo mar. */
    keepVortexInside() {
        const W = this.terrain?.worldW ?? 240;
        const H = this.terrain?.worldH ?? 240;
        let x = this.vortex.x;
        let y = this.vortex.y;
        // Espelha o rumo no eixo da borda: assim ele volta para dentro em vez de raspar na parede.
        if (x < 4) {
            x = 4;
            this.heading = Math.PI - this.heading;
        }
        else if (x > W - 4) {
            x = W - 4;
            this.heading = Math.PI - this.heading;
        }
        if (y < 4) {
            y = 4;
            this.heading = -this.heading;
        }
        else if (y > H - 4) {
            y = H - 4;
            this.heading = -this.heading;
        }
        this.vortex.x = x;
        this.vortex.y = y;
    }
    /** O olho quica nas bordas do mapa em vez de ir embora pelo mar e deixar o tempo aberto. */
    keepStormInside() {
        const W = this.terrain?.worldW ?? 240;
        const H = this.terrain?.worldH ?? 240;
        // Folga larga: a tempestade vem DE FORA do mapa, então a borda de rebate não é o chão,
        // é um anel bem além dele.
        const m = GameConfig_1.GAME_CONFIG.HURRICANE_REACH_TILES;
        let x = this.storm.x;
        let y = this.storm.y;
        if (x < -m) {
            x = -m;
            this.heading = Math.PI - this.heading;
        }
        else if (x > W + m) {
            x = W + m;
            this.heading = Math.PI - this.heading;
        }
        if (y < -m) {
            y = -m;
            this.heading = -this.heading;
        }
        else if (y > H + m) {
            y = H + m;
            this.heading = -this.heading;
        }
        this.storm.x = x;
        this.storm.y = y;
    }
    /**
     * Deslocamento do olho: quase em linha reta, com um desvio preguiçoso. É uma massa de
     * tempestade de cem tiles, não um funil — ela não faz curvas fechadas.
     */
    moveStorm(dt, rng) {
        this.storm.spin += dt * (0.9 + 0.5 * this.strength);
        this.heading += (rng() * 2 - 1) * 0.16 * dt;
        this.windX = Math.cos(this.heading);
        this.windY = Math.sin(this.heading);
        const speed = GameConfig_1.GAME_CONFIG.HURRICANE_TRACK_SPEED * (0.6 + 0.4 * this.strength);
        this.storm.x += this.windX * speed * dt;
        this.storm.y += this.windY * speed * dt;
        this.keepStormInside();
    }
    moveWave(dt, sign) {
        if (!sign)
            return;
        const limit = GameConfig_1.GAME_CONFIG.TSUNAMI_REACH_TILES;
        this.wave.edge += sign * this.wave.dir * GameConfig_1.GAME_CONFIG.TSUNAMI_SPEED * dt;
        const travel = (this.wave.edge - this.wave.from) * this.wave.dir;
        if (travel > limit) {
            this.wave.edge = this.wave.from + this.wave.dir * limit;
            this.wave.reach = limit;
        }
        else if (travel < 0) {
            this.wave.edge = this.wave.from;
            this.wave.reach = 0;
        }
        else {
            this.wave.reach = travel;
        }
    }
    derive() {
        const s = this.strength;
        // O campo de vento é o único número que vale: é ele que `windForce` usa como alcance e
        // é ele que a HazardLayer desenha. Raio visto = raio que puxa, sempre no mesmo tique.
        this.storm.radius = this.kind === 'hurricane'
            ? GameConfig_1.GAME_CONFIG.HURRICANE_REACH_TILES * (0.55 + 0.45 * s) : 0;
        // O céu fecha conforme o olho se aproxima, não porque existe um furacão em algum lugar
        // do mapa. É a contrapartida visual do limite do vento: longe do olho, tempo normal.
        const near = this.kind === 'hurricane' ? this.stormProximity() : 1;
        this.wet = this.kind === 'hurricane' ? s * GameConfig_1.GAME_CONFIG.HURRICANE_WET * near
            : this.kind === 'tsunami' ? s * 0.5 : 0;
        this.dark = this.kind === 'hurricane' ? s * 0.2 * near
            : this.kind === 'tornado' ? s * 0.12 : 0;
        if (this.kind === 'hurricane') {
            const cross = (this.windX - this.windY) * 0.7;
            this.slant = s * near * Math.max(-1.5, Math.min(1.5, cross * (0.6 + 0.4 * this.gust)));
        }
        else if (this.kind === 'tornado') {
            this.slant = s * Math.sin(this.vortex.spin) * 0.5;
        }
        else {
            this.slant = 0;
        }
    }
    /**
     * Quão perto a câmera está do olho, em 0..1: 1 embaixo do olho, 0 quando o campo inteiro
     * já ficou para trás. Dá margem (2 × raio) para a chuva entortar antes de o vento pegar.
     */
    stormProximity() {
        const reach = Math.max(1, this.storm.radius);
        const d = Math.hypot(this.camX - this.storm.x, this.camY - this.storm.y);
        return clamp01(1 - d / (reach * 2));
    }
    vortexForce(x, y, out) {
        const reach = this.vortex.radius * GameConfig_1.GAME_CONFIG.TORNADO_REACH;
        const dx = x - this.vortex.x;
        const dy = y - this.vortex.y;
        const d = Math.hypot(dx, dy);
        if (d > reach)
            return;
        const falloff = 1 - d / reach;
        const k = falloff * falloff * GameConfig_1.GAME_CONFIG.TORNADO_FORCE * this.strength;
        const ux = d > 1e-4 ? dx / d : 1;
        const uy = d > 1e-4 ? dy / d : 0;
        // Giro tangencial por cima da sucção para dentro: é isso que arremessa em círculo.
        out.fx = (-uy * 1.5 - ux * 0.85) * k;
        out.fy = (ux * 1.5 - uy * 0.85) * k;
        out.core = d < this.vortex.radius;
        out.near = true;
    }
    /** Espiral ciclônica em volta do olho: dentro do olho é calmo, na parede do olho arremessa. */
    windForce(x, y, out) {
        const field = this.storm.radius;
        if (field <= 0)
            return;
        const dx = x - this.storm.x;
        const dy = y - this.storm.y;
        const d = Math.hypot(dx, dy);
        if (d > field)
            return;
        const eye = GameConfig_1.GAME_CONFIG.HURRICANE_EYE_TILES;
        const wall = GameConfig_1.GAME_CONFIG.HURRICANE_WALL_TILES;
        // No olho não se ouve nada: é a calmaria que antecede a parede voltar a bater.
        if (d < eye)
            return;
        // Pico na parede do olho e decaimento linear até sumir na borda do campo.
        const profile = d <= wall ? 0.55 + 0.45 * ((d - eye) / Math.max(0.001, wall - eye))
            : Math.max(0, 1 - (d - wall) / Math.max(0.001, field - wall));
        const push = GameConfig_1.GAME_CONFIG.HURRICANE_PUSH * this.strength * profile * (0.5 + 0.5 * this.gust);
        const ux = d > 1e-4 ? dx / d : 1;
        const uy = d > 1e-4 ? dy / d : 0;
        // Tangencial por cima do puxão para dentro, no mesmo sentido do giro da nuvem desenhada.
        out.fx = (-uy * 1.3 - ux * 0.55) * push;
        out.fy = (ux * 1.3 - uy * 0.55) * push;
        out.core = d <= wall;
        out.near = true;
    }
    waveForce(x, y, out) {
        const along = this.wave.axis === 'y' ? y : x;
        const across = this.wave.axis === 'y' ? x : y;
        if (across < this.wave.u0 || across > this.wave.u1)
            return;
        const ahead = (along - this.wave.from) * this.wave.dir;
        const crest = (this.wave.edge - this.wave.from) * this.wave.dir;
        if (ahead > crest + 2.2)
            return;
        const dist = Math.abs(ahead - crest);
        const k = this.strength * (dist < 2.2 ? 1 : 0.3);
        // Na crista a água também empurra para o lado, senão todo mundo morre em linha reta.
        const side = across > (this.wave.u0 + this.wave.u1) / 2 ? 0.5 * k : -0.5 * k;
        const push = this.wave.dir * GameConfig_1.GAME_CONFIG.TSUNAMI_FORCE * k;
        if (this.wave.axis === 'y') {
            out.fy = push;
            out.fx = side;
        }
        else {
            out.fx = push;
            out.fy = side;
        }
        out.core = this.inFlood(x, y);
        out.near = true;
    }
    /**
     * Onde a onda já passou: o corredor de água entre o mar e a crista, mais o lábio de espuma
     * à frente. É a mesma conta do espelho d'água pintado na tela — o que se vê alagado é o que
     * afoga, e andar ali dentro é nadar, não andar.
     */
    inFlood(x, y) {
        const along = this.wave.axis === 'y' ? y : x;
        const across = this.wave.axis === 'y' ? x : y;
        if (across < this.wave.u0 || across > this.wave.u1)
            return false;
        const crest = (this.wave.edge - this.wave.from) * this.wave.dir;
        return (along - this.wave.from) * this.wave.dir <= crest + 1;
    }
    /** Chão coberto pela água do tsunami: quem pisa ali não anda, a corrente arrasta e afoga. */
    floodedAt(x, y) {
        if (this.kind !== 'tsunami' || this.strength <= 0.02)
            return false;
        return this.inFlood(x, y);
    }
    coreDamage(dt) {
        if (this.kind === 'tornado')
            return GameConfig_1.GAME_CONFIG.TORNADO_PLAYER_DMG_S * dt * this.strength;
        if (this.kind === 'tsunami')
            return GameConfig_1.GAME_CONFIG.TSUNAMI_PLAYER_DMG_S * dt * this.strength;
        return GameConfig_1.GAME_CONFIG.HURRICANE_PLAYER_DMG_S * dt * this.strength;
    }
    shakeFor(dt, x, y) {
        if (this.kind === 'hurricane') {
            // A tela treme dentro do campo de vento, e na medida em que ele aperta: na borda do
            // furacão a câmera para de tremer exatamente quando o vento para de empurrar.
            const field = Math.max(0.001, this.storm.radius);
            const d = Math.hypot(x - this.storm.x, y - this.storm.y) / field;
            return dt * 1.6 * this.strength * (0.4 + 0.6 * this.gust) * Math.max(0, 1 - Math.min(1, d));
        }
        const d = this.kind === 'tornado'
            ? Math.hypot(x - this.vortex.x, y - this.vortex.y) / (this.vortex.radius * GameConfig_1.GAME_CONFIG.TORNADO_REACH)
            : Math.abs(((this.wave.axis === 'y' ? y : x) - this.wave.edge) * this.wave.dir) / 8;
        return dt * 3.4 * Math.max(0, 1 - Math.min(1, d)) * this.strength;
    }
    /** Desloca um corpo pela força (dividida pela massa) e resolve o choque com o cenário. */
    body(entity, radius, f, dt, mass, ctx) {
        const k = dt / mass;
        const body = { x: entity.x + f.fx * k, y: entity.y + f.fy * k, radius };
        ctx.clamp(body);
        entity.x = body.x;
        entity.y = body.y;
    }
    kill(npc) {
        if (npc.dead)
            return;
        npc.health = 0;
        npc.dead = true;
        npc.state = 'dead';
        npc.downTimer = 0;
    }
    /** Faixas de água do mapa, varridas uma vez só: o terreno não muda no meio do evento. */
    coasts() {
        const t = this.terrain;
        if (!t)
            return [];
        if (this.coastLines === undefined)
            this.coastLines = this.scanCoasts(t);
        return this.coastLines;
    }
    /**
     * Costa mais perto da câmera. Com `strict`, só vale se o player estiver de fato à beira
     * do mar: sem isso o aviso aparecia para uma onda subindo uma praia do outro lado do mapa.
     */
    nearCoast(strict) {
        let best = null;
        let bestD = Infinity;
        for (const c of this.coasts()) {
            const along = c.axis === 'y' ? this.camY : this.camX;
            const across = c.axis === 'y' ? this.camX : this.camY;
            const water = along < c.water0 ? c.water0 - along : along > c.water1 ? along - c.water1 : 0;
            const span = across < c.span0 ? c.span0 - across : across > c.span1 ? across - c.span1 : 0;
            const d = Math.max(water, span);
            if (d < bestD) {
                bestD = d;
                best = c;
            }
        }
        return strict && bestD > GameConfig_1.GAME_CONFIG.TSUNAMI_NEAR_TILES ? null : best;
    }
    /** Varre as faixas de água deitadas (a onda sobe em Y) e as em pé (a onda sobe em X). */
    scanCoasts(t) {
        const W = Math.floor(t.worldW);
        const H = Math.floor(t.worldH);
        const out = [];
        const take = (axis, water0, water1) => {
            const mid = (water0 + water1) / 2;
            const n = axis === 'y' ? W : H;
            let span0 = -1;
            let span1 = -1;
            for (let i = 0; i < n; i++) {
                const water = axis === 'y' ? t.isWaterWorld(i + 0.5, mid + 0.5) : t.isWaterWorld(mid + 0.5, i + 0.5);
                if (!water)
                    continue;
                if (span0 < 0)
                    span0 = i;
                span1 = i;
            }
            // Sem praia comprida o bastante para a onda caber, a faixa não serve.
            if (span0 >= 0 && span1 - span0 + 1 >= GameConfig_1.GAME_CONFIG.TSUNAMI_SPAN_TILES) {
                out.push({ axis, water0, water1, span0, span1 });
            }
        };
        let run = -1;
        for (let ty = 0; ty <= H; ty++) {
            const sea = ty < H && this.waterIn(t, ty, W, 'y');
            if (sea && run < 0)
                run = ty;
            else if (!sea && run >= 0) {
                take('y', run, ty - 1);
                run = -1;
            }
        }
        run = -1;
        for (let tx = 0; tx <= W; tx++) {
            const sea = tx < W && this.waterIn(t, tx, H, 'x');
            if (sea && run < 0)
                run = tx;
            else if (!sea && run >= 0) {
                take('x', run, tx - 1);
                run = -1;
            }
        }
        return out;
    }
    /** Uma linha/coluna é mar quando tem água comprida o bastante para uma onda passar. */
    waterIn(t, index, count, axis) {
        let n = 0;
        for (let i = 0; i < count; i++) {
            if (axis === 'y' ? t.isWaterWorld(i + 0.5, index + 0.5) : t.isWaterWorld(index + 0.5, i + 0.5))
                n++;
        }
        return n >= WIDE_WATER_TILES;
    }
}
exports.HazardSystem = HazardSystem;
