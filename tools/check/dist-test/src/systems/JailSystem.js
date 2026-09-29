"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JailSystem = void 0;
const GameConfig_1 = require("../game/GameConfig");
const SoundManager_1 = require("../audio/SoundManager");
const NPC_1 = require("../entities/NPC");
const IsoUtils_1 = require("../world/IsoUtils");
const VisionSystem_1 = require("./VisionSystem");
const jail_1 = require("../data/jail");
const INMATE_SPEED = 0.7;
const FLEE_SPEED = 1.9;
const GUARD_SPEED = 1.5;
const GATE_REACH = 1.25;
const KEYS_REACH = 0.5;
const LOOT_REACH = 0.9;
/** Andar em eixo, como o resto do mundo iso: um sprite de 4 direções nunca anda na diagonal. */
function stepToward(o, tx, ty, speed, dt) {
    const dx = tx - o.x, dy = ty - o.y;
    const step = speed * dt;
    const mx = Math.abs(dx) > 0.05 ? Math.sign(dx) * Math.min(Math.abs(dx), step) : 0;
    const my = mx === 0 && Math.abs(dy) > 0.05 ? Math.sign(dy) * Math.min(Math.abs(dy), step) : 0;
    o.x += mx;
    o.y += my;
    if (mx || my)
        o.dir = (0, IsoUtils_1.deltaToDir)(mx, my);
    return { moved: mx !== 0 || my !== 0, reached: Math.abs(dx) <= 0.08 && Math.abs(dy) <= 0.08 };
}
/**
 * A penitenciária de verdade: quem é pego acorda numa cela, cumpre pena e sai pela porta —
 * ou arromba tudo. O guarda só reage quando enxerga o fugitivo, e encostar nele devolve
 * o preso para trás das grades. O sistema manda nas celas, no guarda e nos presos; quem
 * desenha as grades e cobra a pena na interface é o `InteriorSystem`/`GameState` pelo contexto.
 */
class JailSystem {
    constructor() {
        this.occupants = [];
        /** true = grade aberta. O índice é o de `JAIL_GATE_SLOTS` (celas + depósito). */
        this.gates = jail_1.JAIL_GATE_SLOTS.map(() => false);
        /** O jogador está dentro da sala da cadeia agora. */
        this.inside = false;
        /** Pena em curso: a cela do jogador está trancada e o relógio corre. */
        this.locked = false;
        this.sentenceLeft = 0;
        this.alarm = false;
        this.keysHeld = false;
        this.keysOnFloor = null;
        /** Presos que saíram pela porta nesta sessão de invasão. */
        this.freed = 0;
        /** O jogador está solto por dentro e deveria estar contido: o guarda caça. */
        this.atLarge = false;
        /** Relógio da caçada: o guarda procura o último lugar onde viu o fugitivo. */
        this.alert = 0;
        this.lastSeen = null;
        /** Pena que ainda restava quando o jogador arrombou a própria cela. */
        this.remainingAtBreak = 0;
        /** A pistola do depósito já foi pega nesta sessão. */
        this.armoryLooted = false;
        this.nextId = 90000;
    }
    /** Sentença proporcional às estrelas: uma infração pequena não prende ninguém por minuto. */
    static sentenceFor(wantedLevel) {
        return GameConfig_1.GAME_CONFIG.JAIL_BASE_S + Math.round(wantedLevel) * GameConfig_1.GAME_CONFIG.JAIL_PER_STAR_S;
    }
    /** Cria presos e guarda uma única vez: sair e voltar não gera outra população. */
    populate(rng = Math.random) {
        if (this.occupants.length)
            return;
        for (const inmate of jail_1.JAIL_INMATES) {
            const walk = (0, jail_1.jailCellWalk)(inmate.cell);
            const x = walk.x0 + rng() * (walk.x1 - walk.x0);
            const y = walk.y0 + rng() * (walk.y1 - walk.y0);
            this.occupants.push({ ...(0, NPC_1.createNPC)(this.nextId++, inmate.char, x, y, 'civ', rng),
                cell: inmate.cell, free: false, tx: x, ty: y, wait: rng() * 2, punchCooldown: 0 });
        }
        this.occupants.push({ ...(0, NPC_1.createNPC)(this.nextId++, 'b', jail_1.JAIL_PATROL[0].x, jail_1.JAIL_PATROL[0].y, 'cop', rng),
            cell: -1, free: false, tx: jail_1.JAIL_PATROL[1].x, ty: jail_1.JAIL_PATROL[1].y, wait: 0, punchCooldown: 0 });
    }
    /** Algemado e levado para dentro: a cela do jogador fecha e a pena começa a correr. */
    incarcerate(seconds) {
        this.populate();
        this.inside = true;
        this.locked = true;
        this.sentenceLeft = seconds;
        this.alarm = false;
        this.atLarge = false;
        this.alert = 0;
        this.lastSeen = null;
        this.keysHeld = false;
        this.keysOnFloor = null;
        this.remainingAtBreak = 0;
        this.armoryLooted = false;
        this.freed = 0;
        this.gates = jail_1.JAIL_GATE_SLOTS.map(() => false);
    }
    enter() {
        this.inside = true;
        this.populate();
    }
    /** Busca estável para o sprite: o índice muda quando um preso escapa, o id não. */
    byId(id) {
        return this.occupants.find((o) => o.id === id);
    }
    leave() {
        this.inside = false;
    }
    gateOpen(index) {
        return this.gates[index] ?? true;
    }
    /** Grades fechadas bloqueiam o jogador — colisão dinâmica, porque cela aberta some. */
    blockPlayer(player, collision) {
        if (!this.inside)
            return;
        const closed = this.closedGates();
        if (!closed.length)
            return;
        const circle = { x: player.x, y: player.y, radius: GameConfig_1.GAME_CONFIG.PLAYER_RADIUS };
        collision.resolveCircle(circle, closed);
        player.x = circle.x;
        player.y = circle.y;
    }
    closedGates() {
        const list = [];
        for (let i = 0; i < this.gates.length; i++) {
            if (this.gates[i])
                continue;
            const s = jail_1.JAIL_GATE_SLOTS[i];
            list.push({ x: s.x, y: s.y, width: s.width, height: s.height, type: 'BUILDING' });
        }
        return list;
    }
    update(dt, ctx) {
        if (!this.inside)
            return;
        const player = ctx.player;
        if (this.locked) {
            this.sentenceLeft = Math.max(0, this.sentenceLeft - dt);
            if (this.sentenceLeft === 0) {
                this.locked = false;
                this.gates[jail_1.JAIL_PLAYER_CELL] = true;
                SoundManager_1.sound.play('doorOpen', 0.5);
                ctx.say('Pena cumprida. A cela está aberta');
            }
        }
        if (this.keysOnFloor && Math.hypot(player.x - this.keysOnFloor.x, player.y - this.keysOnFloor.y) < KEYS_REACH) {
            this.keysOnFloor = null;
            this.keysHeld = true;
            SoundManager_1.sound.play('uiSwitch', 0.5);
            ctx.say('Você pegou as chaves do guarda');
            ctx.notify();
        }
        const keep = [];
        for (const o of this.occupants) {
            if (o.dead) {
                if (o.deathTimer < 0)
                    o.deathTimer = 0;
                o.deathTimer += dt;
                if (o.deathTimer < NPC_1.NPC_CORPSE_LIFETIME_S)
                    keep.push(o);
                else
                    ctx.notify();
                continue;
            }
            if (o.downTimer > 0) {
                o.downTimer = Math.max(0, o.downTimer - dt);
                o.state = 'knocked';
                o.anim = 'idle';
                o.speed = 0;
                if (o.cell === -1 && !this.keysHeld && !this.keysOnFloor)
                    this.dropKeys(o);
                keep.push(o);
                continue;
            }
            if (o.state === 'knocked') {
                o.state = 'idle';
                ctx.notify();
            }
            if (o.cell === -1)
                this.updateGuard(o, ctx, dt);
            else if (!this.updateInmate(o, ctx, dt))
                continue;
            keep.push(o);
        }
        if (keep.length !== this.occupants.length)
            ctx.notify();
        this.occupants = keep;
    }
    /**
     * Derrubado do lado de fora, o guarda joga as chaves para dentro da cela: é o único jeito
     * de um preso desarmado escapar antes da hora. Longe do canto de dormir, para ter que andar.
     */
    dropKeys(guard) {
        const cell = jail_1.JAIL_CELLS[jail_1.JAIL_PLAYER_CELL];
        this.keysOnFloor = this.locked
            ? { x: cell.x1 - 0.5, y: jail_1.JAIL_FRONT_Y - 0.55 }
            : { x: guard.x, y: guard.y };
        SoundManager_1.sound.play('metalHit', 0.45);
    }
    /**
     * O guarda vê dentro do alcance e do arco da sua direção. Ele não tem plantas do
     * prédio para raycast (as grades são transparentes de propósito), então a visão é
     * a cone pura do VisionSystem — a mesma geometria que a polícia usa na rua.
     */
    canSee(guard, player) {
        return (0, VisionSystem_1.inCone)({ x: guard.x, y: guard.y, dir: guard.dir, alert: this.alert > 0 ? 1 : 0 }, { x: player.x, y: player.y, crouched: player.crouching }, { range: GameConfig_1.GAME_CONFIG.GUARD_SIGHT_RANGE, halfFov: GameConfig_1.GAME_CONFIG.GUARD_FOV_HALF });
    }
    updateGuard(o, ctx, dt) {
        const player = ctx.player;
        if (this.atLarge) {
            if (this.canSee(o, player)) {
                if (!this.alarm) {
                    this.alarm = true;
                    SoundManager_1.sound.play('metalHit', 0.7);
                    ctx.say('O guarda te viu fora da cela');
                    ctx.notify();
                }
                this.alert = GameConfig_1.GAME_CONFIG.GUARD_ALERT_S;
                this.lastSeen = { x: player.x, y: player.y };
            }
            else {
                this.alert = Math.max(0, this.alert - dt);
            }
        }
        const chase = this.atLarge && this.alert > 0;
        const distance = Math.hypot(player.x - o.x, player.y - o.y);
        if (chase && distance < GameConfig_1.GAME_CONFIG.GUARD_CATCH_RADIUS) {
            o.anim = 'idle';
            o.speed = 0;
            this.recapture(ctx);
            return;
        }
        const target = chase ? (this.lastSeen ?? { x: player.x, y: player.y }) : { x: o.tx, y: o.ty };
        const { moved, reached } = stepToward(o, target.x, target.y, chase ? GUARD_SPEED * 1.3 : GUARD_SPEED, dt);
        o.state = moved ? 'walking' : 'idle';
        o.anim = moved ? 'walk' : 'idle';
        o.speed = moved ? GUARD_SPEED : 0;
        this.animate(o, moved, dt);
        if (!chase && reached) {
            o.wait -= dt;
            if (o.wait <= 0) {
                const next = o.tx === jail_1.JAIL_PATROL[0].x ? 1 : 0;
                o.tx = jail_1.JAIL_PATROL[next].x;
                o.ty = jail_1.JAIL_PATROL[next].y;
                o.wait = 1.4;
            }
        }
    }
    /**
     * Contenção: o guarda encosta no fugitivo e o devolve para a cela. A pena recomeça com o
     * tempo que ainda restava mais um castigo, e as chaves confiscadas voltam para o bolso dele.
     */
    recapture(ctx) {
        const player = ctx.player;
        this.atLarge = false;
        this.alarm = false;
        this.alert = 0;
        this.lastSeen = null;
        this.keysHeld = false;
        this.keysOnFloor = null;
        this.locked = true;
        this.sentenceLeft = this.remainingAtBreak + GameConfig_1.GAME_CONFIG.JAIL_BREAK_PENALTY_S;
        this.gates = jail_1.JAIL_GATE_SLOTS.map(() => false);
        player.x = jail_1.JAIL_CELL_SPAWN.x;
        player.y = jail_1.JAIL_CELL_SPAWN.y;
        SoundManager_1.sound.play('bodyHit', 0.55);
        ctx.say(`O guarda te conteve — de volta à cela, +${GameConfig_1.GAME_CONFIG.JAIL_BREAK_PENALTY_S} s`);
        ctx.notify();
    }
    /** False quando o preso saiu pela porta e não pertence mais à sala. */
    updateInmate(o, ctx, dt) {
        if (o.free) {
            const { reached } = stepToward(o, jail_1.JAIL_EXIT.x, jail_1.JAIL_EXIT.y, FLEE_SPEED, dt);
            o.state = 'fleeing';
            o.anim = 'walk';
            o.speed = FLEE_SPEED;
            this.animate(o, true, dt);
            if (!reached)
                return true;
            this.freed++;
            ctx.releaseInmate(o);
            return false;
        }
        const walk = (0, jail_1.jailCellWalk)(o.cell);
        o.wait -= dt;
        if (o.wait <= 0) {
            o.tx = walk.x0 + Math.random() * (walk.x1 - walk.x0);
            o.ty = walk.y0 + Math.random() * (walk.y1 - walk.y0);
            o.wait = 1.6 + Math.random() * 3.4;
        }
        const { moved } = stepToward(o, o.tx, o.ty, INMATE_SPEED, dt);
        o.state = moved ? 'walking' : 'idle';
        o.anim = moved ? 'walk' : 'idle';
        o.speed = moved ? INMATE_SPEED : 0;
        this.animate(o, moved, dt);
        return true;
    }
    animate(o, moving, dt) {
        o.animTimer += dt * 1000;
        const frameMs = moving ? 190 : 420;
        if (o.animTimer >= frameMs) {
            o.animTimer = 0;
            o.frame = (o.frame + 1) % 4;
        }
    }
    /** Índice do vão gradesado mais próximo do jogador, ou -1 longe de todos. */
    nearGate(player) {
        for (let i = 0; i < jail_1.JAIL_GATE_SLOTS.length; i++) {
            const s = jail_1.JAIL_GATE_SLOTS[i];
            if (player.x >= s.x - 0.2 && player.x <= s.x + s.width + 0.2
                && player.y >= s.y - GATE_REACH && player.y <= s.y + s.height + GATE_REACH)
                return i;
        }
        return -1;
    }
    prompt(player) {
        const gate = this.nearGate(player);
        if (gate >= 0 && !this.gates[gate]) {
            if (gate === jail_1.JAIL_ARMORY_GATE) {
                return this.keysHeld ? 'Abrir o depósito de armas' : 'Depósito trancado · pede as chaves';
            }
            return this.keysHeld ? 'Destrancar a cela'
                : this.locked && gate === jail_1.JAIL_PLAYER_CELL ? `Cela trancada · ${Math.ceil(this.sentenceLeft)} s`
                    : 'Cela trancada';
        }
        if (this.armoryReachable(player)) {
            return this.armoryLooted ? 'Depósito vazio' : 'Pegar a pistola do depósito';
        }
        if (Math.hypot(player.x - jail_1.JAIL_PANEL.x, player.y - jail_1.JAIL_PANEL.y) < GATE_REACH) {
            return this.gates.slice(0, jail_1.JAIL_CELLS.length).every((open) => open) ? 'Painel de celas · tudo aberto'
                : this.keysHeld ? 'Painel · abrir todas as celas' : 'Painel de celas · pede as chaves';
        }
        if (this.locked)
            return this.keysHeld ? `Pena · ${Math.ceil(this.sentenceLeft)} s · cela destrancável`
                : `Pena · ${Math.ceil(this.sentenceLeft)} s`;
        return null;
    }
    /** A arma do depósito só alcançável com a grade do depósito aberta. */
    armoryReachable(player) {
        return this.gates[jail_1.JAIL_ARMORY_GATE]
            && Math.hypot(player.x - jail_1.JAIL_ARMORY.loot.x, player.y - jail_1.JAIL_ARMORY.loot.y) < LOOT_REACH;
    }
    tryInteract(ctx) {
        if (!this.inside)
            return false;
        const player = ctx.player;
        const gate = this.nearGate(player);
        if (gate >= 0 && !this.gates[gate]) {
            if (!this.keysHeld) {
                ctx.say(gate === jail_1.JAIL_ARMORY_GATE ? 'O depósito não abre sem as chaves'
                    : this.locked && gate === jail_1.JAIL_PLAYER_CELL
                        ? `Trancada · faltam ${Math.ceil(this.sentenceLeft)} s` : 'A grade não abre sem as chaves');
                return true;
            }
            this.gates[gate] = true;
            SoundManager_1.sound.play('doorOpen', 0.55);
            if (gate === jail_1.JAIL_ARMORY_GATE)
                ctx.say('O depósito de armas abriu');
            else if (this.locked && gate === jail_1.JAIL_PLAYER_CELL)
                this.escapeEarly(ctx);
            else
                ctx.say('Cela aberta');
            ctx.notify();
            return true;
        }
        if (this.armoryReachable(player)) {
            if (this.armoryLooted) {
                ctx.say('O depósito já está vazio');
                return true;
            }
            const fresh = ctx.grantGun ? ctx.grantGun('pistol') : true;
            if (!fresh) {
                ctx.say('Você já tem essa pistola');
                return true;
            }
            this.armoryLooted = true;
            SoundManager_1.sound.play('coin', 0.5);
            ctx.say('Pistola do depósito');
            ctx.notify();
            return true;
        }
        if (Math.hypot(player.x - jail_1.JAIL_PANEL.x, player.y - jail_1.JAIL_PANEL.y) >= GATE_REACH)
            return false;
        if (!this.keysHeld) {
            ctx.say('O painel só responde com as chaves do guarda');
            return true;
        }
        if (this.gates.slice(0, jail_1.JAIL_CELLS.length).every((open) => open)) {
            ctx.say('Não há mais ninguém trancado');
            return true;
        }
        this.gates = this.gates.map(() => true);
        let released = 0;
        for (const o of this.occupants)
            if (o.cell >= 0 && !o.dead) {
                o.free = true;
                o.state = 'fleeing';
                released++;
            }
        this.invade(ctx);
        ctx.say(released ? `${released} presos soltos — eles correm para a rua` : 'Todas as celas abertas');
        ctx.notify();
        return true;
    }
    /** Arrombar a própria cela antes de cumprir a pena: fuga silenciosa, até o guarda te ver. */
    escapeEarly(ctx) {
        this.remainingAtBreak = this.sentenceLeft;
        this.locked = false;
        this.atLarge = true;
        ctx.raiseWanted(GameConfig_1.GAME_CONFIG.WANTED_JAILBREAK);
    }
    /** Abrir o painel é barulho: solta todo mundo, dispara o alarme e o guarda vem na hora. */
    invade(ctx) {
        if (this.locked) {
            this.remainingAtBreak = this.sentenceLeft;
            this.locked = false;
            ctx.raiseWanted(GameConfig_1.GAME_CONFIG.WANTED_JAILBREAK);
        }
        else {
            ctx.raiseWanted(GameConfig_1.GAME_CONFIG.WANTED_JAILBREAK - 1);
        }
        this.atLarge = true;
        this.alarm = true;
        this.alert = GameConfig_1.GAME_CONFIG.GUARD_ALERT_S;
    }
}
exports.JailSystem = JailSystem;
