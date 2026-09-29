import { GAME_CONFIG } from '../game/GameConfig';
import { sound } from '../audio/SoundManager';
import { createNPC, NPC_CORPSE_LIFETIME_S, type NPC } from '../entities/NPC';
import type { Player } from '../entities/Player';
import type { Collider } from '../entities/types';
import type { GunId } from '../data/weapons';
import { deltaToDir } from '../world/IsoUtils';
import { inCone } from './VisionSystem';
import type { CollisionSystem } from './CollisionSystem';
import {
  JAIL_ARMORY, JAIL_ARMORY_GATE, JAIL_CELLS, JAIL_CELL_SPAWN, JAIL_EXIT, JAIL_FRONT_Y,
  JAIL_GATE_SLOTS, JAIL_INMATES, JAIL_PANEL, JAIL_PATROL, JAIL_PLAYER_CELL, jailCellWalk,
} from '../data/jail';

/** Um preso (ou o guarda) da cadeia: é um NPC comum, com a cela de origem em cima. */
export interface JailOccupant extends NPC {
  /** Índice da cela; -1 para o guarda. */
  cell: number;
  free: boolean;
  tx: number;
  ty: number;
  wait: number;
  punchCooldown: number;
}

export interface JailContext {
  player: Player;
  /** Soco do guarda. False quando o jogador ainda está invulnerável. */
  damagePlayer: (amount: number) => boolean;
  raiseWanted: (stars: number) => void;
  /** Preso que chega à porta já solto vira pedestre na rua. */
  releaseInmate: (inmate: JailOccupant) => void;
  /** Entrega a arma do depósito ao jogador; false quando ele já a tem. */
  grantGun?: (id: GunId) => boolean;
  say: (text: string) => void;
  notify: () => void;
}

const INMATE_SPEED = 0.7;
const FLEE_SPEED = 1.9;
const GUARD_SPEED = 1.5;
const GATE_REACH = 1.25;
const KEYS_REACH = 0.5;
const LOOT_REACH = 0.9;

/** Andar em eixo, como o resto do mundo iso: um sprite de 4 direções nunca anda na diagonal. */
function stepToward(o: { x: number; y: number; dir: NPC['dir'] }, tx: number, ty: number, speed: number, dt: number) {
  const dx = tx - o.x, dy = ty - o.y;
  const step = speed * dt;
  const mx = Math.abs(dx) > 0.05 ? Math.sign(dx) * Math.min(Math.abs(dx), step) : 0;
  const my = mx === 0 && Math.abs(dy) > 0.05 ? Math.sign(dy) * Math.min(Math.abs(dy), step) : 0;
  o.x += mx;
  o.y += my;
  if (mx || my) o.dir = deltaToDir(mx, my);
  return { moved: mx !== 0 || my !== 0, reached: Math.abs(dx) <= 0.08 && Math.abs(dy) <= 0.08 };
}

/**
 * A penitenciária de verdade: quem é pego acorda numa cela, cumpre pena e sai pela porta —
 * ou arromba tudo. O guarda só reage quando enxerga o fugitivo, e encostar nele devolve
 * o preso para trás das grades. O sistema manda nas celas, no guarda e nos presos; quem
 * desenha as grades e cobra a pena na interface é o `InteriorSystem`/`GameState` pelo contexto.
 */
export class JailSystem {
  occupants: JailOccupant[] = [];
  /** true = grade aberta. O índice é o de `JAIL_GATE_SLOTS` (celas + depósito). */
  gates: boolean[] = JAIL_GATE_SLOTS.map(() => false);
  /** O jogador está dentro da sala da cadeia agora. */
  inside = false;
  /** Pena em curso: a cela do jogador está trancada e o relógio corre. */
  locked = false;
  sentenceLeft = 0;
  alarm = false;
  keysHeld = false;
  keysOnFloor: { x: number; y: number } | null = null;
  /** Presos que saíram pela porta nesta sessão de invasão. */
  freed = 0;
  /** O jogador está solto por dentro e deveria estar contido: o guarda caça. */
  atLarge = false;
  /** Relógio da caçada: o guarda procura o último lugar onde viu o fugitivo. */
  alert = 0;
  lastSeen: { x: number; y: number } | null = null;
  /** Pena que ainda restava quando o jogador arrombou a própria cela. */
  remainingAtBreak = 0;
  /** A pistola do depósito já foi pega nesta sessão. */
  armoryLooted = false;

  private nextId = 90000;

  /** Sentença proporcional às estrelas: uma infração pequena não prende ninguém por minuto. */
  static sentenceFor(wantedLevel: number) {
    return GAME_CONFIG.JAIL_BASE_S + Math.round(wantedLevel) * GAME_CONFIG.JAIL_PER_STAR_S;
  }

  /** Cria presos e guarda uma única vez: sair e voltar não gera outra população. */
  populate(rng: () => number = Math.random) {
    if (this.occupants.length) return;
    for (const inmate of JAIL_INMATES) {
      const walk = jailCellWalk(inmate.cell);
      const x = walk.x0 + rng() * (walk.x1 - walk.x0);
      const y = walk.y0 + rng() * (walk.y1 - walk.y0);
      this.occupants.push({ ...createNPC(this.nextId++, inmate.char, x, y, 'civ', rng),
        cell: inmate.cell, free: false, tx: x, ty: y, wait: rng() * 2, punchCooldown: 0 });
    }
    this.occupants.push({ ...createNPC(this.nextId++, 'b', JAIL_PATROL[0].x, JAIL_PATROL[0].y, 'cop', rng),
      cell: -1, free: false, tx: JAIL_PATROL[1].x, ty: JAIL_PATROL[1].y, wait: 0, punchCooldown: 0 });
  }

  /** Algemado e levado para dentro: a cela do jogador fecha e a pena começa a correr. */
  incarcerate(seconds: number) {
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
    this.gates = JAIL_GATE_SLOTS.map(() => false);
  }

  enter() {
    this.inside = true;
    this.populate();
  }

  /** Busca estável para o sprite: o índice muda quando um preso escapa, o id não. */
  byId(id: number): JailOccupant | undefined {
    return this.occupants.find((o) => o.id === id);
  }

  leave() {
    this.inside = false;
  }

  gateOpen(index: number) {
    return this.gates[index] ?? true;
  }

  /** Grades fechadas bloqueiam o jogador — colisão dinâmica, porque cela aberta some. */
  blockPlayer(player: Player, collision: CollisionSystem) {
    if (!this.inside) return;
    const closed = this.closedGates();
    if (!closed.length) return;
    const circle = { x: player.x, y: player.y, radius: GAME_CONFIG.PLAYER_RADIUS };
    collision.resolveCircle(circle, closed);
    player.x = circle.x;
    player.y = circle.y;
  }

  closedGates(): Collider[] {
    const list: Collider[] = [];
    for (let i = 0; i < this.gates.length; i++) {
      if (this.gates[i]) continue;
      const s = JAIL_GATE_SLOTS[i];
      list.push({ x: s.x, y: s.y, width: s.width, height: s.height, type: 'BUILDING' });
    }
    return list;
  }

  update(dt: number, ctx: JailContext) {
    if (!this.inside) return;
    const player = ctx.player;
    if (this.locked) {
      this.sentenceLeft = Math.max(0, this.sentenceLeft - dt);
      if (this.sentenceLeft === 0) {
        this.locked = false;
        this.gates[JAIL_PLAYER_CELL] = true;
        sound.play('doorOpen', 0.5);
        ctx.say('Pena cumprida. A cela está aberta');
      }
    }
    if (this.keysOnFloor && Math.hypot(player.x - this.keysOnFloor.x, player.y - this.keysOnFloor.y) < KEYS_REACH) {
      this.keysOnFloor = null;
      this.keysHeld = true;
      sound.play('uiSwitch', 0.5);
      ctx.say('Você pegou as chaves do guarda');
      ctx.notify();
    }
    const keep: JailOccupant[] = [];
    for (const o of this.occupants) {
      if (o.dead) {
        if (o.deathTimer < 0) o.deathTimer = 0;
        o.deathTimer += dt;
        if (o.deathTimer < NPC_CORPSE_LIFETIME_S) keep.push(o);
        else ctx.notify();
        continue;
      }
      if (o.downTimer > 0) {
        o.downTimer = Math.max(0, o.downTimer - dt);
        o.state = 'knocked';
        o.anim = 'idle';
        o.speed = 0;
        if (o.cell === -1 && !this.keysHeld && !this.keysOnFloor) this.dropKeys(o);
        keep.push(o);
        continue;
      }
      if (o.state === 'knocked') {
        o.state = 'idle';
        ctx.notify();
      }
      if (o.cell === -1) this.updateGuard(o, ctx, dt);
      else if (!this.updateInmate(o, ctx, dt)) continue;
      keep.push(o);
    }
    if (keep.length !== this.occupants.length) ctx.notify();
    this.occupants = keep;
  }

  /**
   * Derrubado do lado de fora, o guarda joga as chaves para dentro da cela: é o único jeito
   * de um preso desarmado escapar antes da hora. Longe do canto de dormir, para ter que andar.
   */
  private dropKeys(guard: JailOccupant) {
    const cell = JAIL_CELLS[JAIL_PLAYER_CELL];
    this.keysOnFloor = this.locked
      ? { x: cell.x1 - 0.5, y: JAIL_FRONT_Y - 0.55 }
      : { x: guard.x, y: guard.y };
    sound.play('metalHit', 0.45);
  }

  /**
   * O guarda vê dentro do alcance e do arco da sua direção. Ele não tem plantas do
   * prédio para raycast (as grades são transparentes de propósito), então a visão é
   * a cone pura do VisionSystem — a mesma geometria que a polícia usa na rua.
   */
  private canSee(guard: JailOccupant, player: Player) {
    return inCone({ x: guard.x, y: guard.y, dir: guard.dir, alert: this.alert > 0 ? 1 : 0 },
      { x: player.x, y: player.y, crouched: player.crouching },
      { range: GAME_CONFIG.GUARD_SIGHT_RANGE, halfFov: GAME_CONFIG.GUARD_FOV_HALF });
  }

  private updateGuard(o: JailOccupant, ctx: JailContext, dt: number) {
    const player = ctx.player;
    if (this.atLarge) {
      if (this.canSee(o, player)) {
        if (!this.alarm) {
          this.alarm = true;
          sound.play('metalHit', 0.7);
          ctx.say('O guarda te viu fora da cela');
          ctx.notify();
        }
        this.alert = GAME_CONFIG.GUARD_ALERT_S;
        this.lastSeen = { x: player.x, y: player.y };
      } else {
        this.alert = Math.max(0, this.alert - dt);
      }
    }
    const chase = this.atLarge && this.alert > 0;
    const distance = Math.hypot(player.x - o.x, player.y - o.y);
    if (chase && distance < GAME_CONFIG.GUARD_CATCH_RADIUS) {
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
        const next = o.tx === JAIL_PATROL[0].x ? 1 : 0;
        o.tx = JAIL_PATROL[next].x;
        o.ty = JAIL_PATROL[next].y;
        o.wait = 1.4;
      }
    }
  }

  /**
   * Contenção: o guarda encosta no fugitivo e o devolve para a cela. A pena recomeça com o
   * tempo que ainda restava mais um castigo, e as chaves confiscadas voltam para o bolso dele.
   */
  private recapture(ctx: JailContext) {
    const player = ctx.player;
    this.atLarge = false;
    this.alarm = false;
    this.alert = 0;
    this.lastSeen = null;
    this.keysHeld = false;
    this.keysOnFloor = null;
    this.locked = true;
    this.sentenceLeft = this.remainingAtBreak + GAME_CONFIG.JAIL_BREAK_PENALTY_S;
    this.gates = JAIL_GATE_SLOTS.map(() => false);
    player.x = JAIL_CELL_SPAWN.x;
    player.y = JAIL_CELL_SPAWN.y;
    sound.play('bodyHit', 0.55);
    ctx.say(`O guarda te conteve — de volta à cela, +${GAME_CONFIG.JAIL_BREAK_PENALTY_S} s`);
    ctx.notify();
  }

  /** False quando o preso saiu pela porta e não pertence mais à sala. */
  private updateInmate(o: JailOccupant, ctx: JailContext, dt: number): boolean {
    if (o.free) {
      const { reached } = stepToward(o, JAIL_EXIT.x, JAIL_EXIT.y, FLEE_SPEED, dt);
      o.state = 'fleeing';
      o.anim = 'walk';
      o.speed = FLEE_SPEED;
      this.animate(o, true, dt);
      if (!reached) return true;
      this.freed++;
      ctx.releaseInmate(o);
      return false;
    }
    const walk = jailCellWalk(o.cell);
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

  private animate(o: JailOccupant, moving: boolean, dt: number) {
    o.animTimer += dt * 1000;
    const frameMs = moving ? 190 : 420;
    if (o.animTimer >= frameMs) {
      o.animTimer = 0;
      o.frame = (o.frame + 1) % 4;
    }
  }

  /** Índice do vão gradesado mais próximo do jogador, ou -1 longe de todos. */
  private nearGate(player: Player) {
    for (let i = 0; i < JAIL_GATE_SLOTS.length; i++) {
      const s = JAIL_GATE_SLOTS[i];
      if (player.x >= s.x - 0.2 && player.x <= s.x + s.width + 0.2
        && player.y >= s.y - GATE_REACH && player.y <= s.y + s.height + GATE_REACH) return i;
    }
    return -1;
  }

  prompt(player: Player): string | null {
    const gate = this.nearGate(player);
    if (gate >= 0 && !this.gates[gate]) {
      if (gate === JAIL_ARMORY_GATE) {
        return this.keysHeld ? 'Abrir o depósito de armas' : 'Depósito trancado · pede as chaves';
      }
      return this.keysHeld ? 'Destrancar a cela'
        : this.locked && gate === JAIL_PLAYER_CELL ? `Cela trancada · ${Math.ceil(this.sentenceLeft)} s`
          : 'Cela trancada';
    }
    if (this.armoryReachable(player)) {
      return this.armoryLooted ? 'Depósito vazio' : 'Pegar a pistola do depósito';
    }
    if (Math.hypot(player.x - JAIL_PANEL.x, player.y - JAIL_PANEL.y) < GATE_REACH) {
      return this.gates.slice(0, JAIL_CELLS.length).every((open) => open) ? 'Painel de celas · tudo aberto'
        : this.keysHeld ? 'Painel · abrir todas as celas' : 'Painel de celas · pede as chaves';
    }
    if (this.locked) return this.keysHeld ? `Pena · ${Math.ceil(this.sentenceLeft)} s · cela destrancável`
      : `Pena · ${Math.ceil(this.sentenceLeft)} s`;
    return null;
  }

  /** A arma do depósito só alcançável com a grade do depósito aberta. */
  private armoryReachable(player: Player) {
    return this.gates[JAIL_ARMORY_GATE]
      && Math.hypot(player.x - JAIL_ARMORY.loot.x, player.y - JAIL_ARMORY.loot.y) < LOOT_REACH;
  }

  tryInteract(ctx: JailContext): boolean {
    if (!this.inside) return false;
    const player = ctx.player;
    const gate = this.nearGate(player);
    if (gate >= 0 && !this.gates[gate]) {
      if (!this.keysHeld) {
        ctx.say(gate === JAIL_ARMORY_GATE ? 'O depósito não abre sem as chaves'
          : this.locked && gate === JAIL_PLAYER_CELL
            ? `Trancada · faltam ${Math.ceil(this.sentenceLeft)} s` : 'A grade não abre sem as chaves');
        return true;
      }
      this.gates[gate] = true;
      sound.play('doorOpen', 0.55);
      if (gate === JAIL_ARMORY_GATE) ctx.say('O depósito de armas abriu');
      else if (this.locked && gate === JAIL_PLAYER_CELL) this.escapeEarly(ctx);
      else ctx.say('Cela aberta');
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
      sound.play('coin', 0.5);
      ctx.say('Pistola do depósito');
      ctx.notify();
      return true;
    }
    if (Math.hypot(player.x - JAIL_PANEL.x, player.y - JAIL_PANEL.y) >= GATE_REACH) return false;
    if (!this.keysHeld) {
      ctx.say('O painel só responde com as chaves do guarda');
      return true;
    }
    if (this.gates.slice(0, JAIL_CELLS.length).every((open) => open)) {
      ctx.say('Não há mais ninguém trancado');
      return true;
    }
    this.gates = this.gates.map(() => true);
    let released = 0;
    for (const o of this.occupants) if (o.cell >= 0 && !o.dead) {
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
  private escapeEarly(ctx: JailContext) {
    this.remainingAtBreak = this.sentenceLeft;
    this.locked = false;
    this.atLarge = true;
    ctx.raiseWanted(GAME_CONFIG.WANTED_JAILBREAK);
  }

  /** Abrir o painel é barulho: solta todo mundo, dispara o alarme e o guarda vem na hora. */
  private invade(ctx: JailContext) {
    if (this.locked) {
      this.remainingAtBreak = this.sentenceLeft;
      this.locked = false;
      ctx.raiseWanted(GAME_CONFIG.WANTED_JAILBREAK);
    } else {
      ctx.raiseWanted(GAME_CONFIG.WANTED_JAILBREAK - 1);
    }
    this.atLarge = true;
    this.alarm = true;
    this.alert = GAME_CONFIG.GUARD_ALERT_S;
  }
}
