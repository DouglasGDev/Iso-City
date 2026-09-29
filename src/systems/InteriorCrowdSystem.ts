import { createNPC, bloodStains, NPC_CORPSE_LIFETIME_S, type NPC } from '../entities/NPC';
import { GAME_CONFIG, type Dir4 } from '../game/GameConfig';
import type { Player } from '../entities/Player';
import { deltaToDir } from '../world/IsoUtils';
import type { CollisionSystem } from './CollisionSystem';
import type { Furniture, InteriorRoom } from './InteriorSystem';
import { crowdRolesFor, type CrowdRole } from '../data/interiorCrowd';

/** Um habitante da sala: NPC comum, mas preso às coordenadas do quarto e ao seu papel. */
export interface RoomOccupant extends NPC {
  role: CrowdRole;
  /** Base do papel: é em volta dela que a pessoa anda enquanto não corre. */
  baseX: number;
  baseY: number;
  roam: number;
  walkSpeed: number;
  tx: number;
  ty: number;
  wait: number;
  /** Segundos restantes de pânico; enquanto corre, o alvo é o canto mais afastado. */
  panic: number;
  /** Distância ao alvo medida no último sondeo: é o que diz se a pessoa anda ou treme. */
  remain: number;
  /** Tempo restante do desvio em volta do móvel que está no caminho. */
  rounding: number;
  /** Destino guardado enquanto a pessoa contorna. */
  gx: number;
  gy: number;
  /** Fundo do susto: a distância máxima já arrancada de quem atirou. */
  guard: number;
}

export interface CrowdContext {
  player: Player;
  room: InteriorRoom;
  collision: CollisionSystem;
  /** O jogador atirou ou bateu neste tick: quem ouve larga o que estava fazendo. */
  shot: boolean;
  melee: boolean;
  notify: () => void;
}

/** Estado de um único tick, para os métodos privados não carregarem quatro argumentos. */
interface Frame {
  room: InteriorRoom;
  player: Player;
  collision: CollisionSystem;
  dt: number;
  /** Alcance do susto deste tick: 0 quando ninguém atirou nem bateu. */
  heard: number;
}

const FLEE_SPEED = 1.7;
/** O tiro fecha a sala inteira; um soco só assusta quem está perto dele. */
const HEAR_SHOT = 5.5;
const HEAR_MELEE = 3.2;
/** Quem vê o colega correr também corre. */
const PANIC_SPREAD = 2.6;
const PANIC_S = 7;
/** Janela de empate da fuga: para longe o bastante, mas cada um no seu canto. */
const FLEE_TIE = 1;
/** Correr só vale se deixar mais longe de quem atirou. */
const ESCAPE_GAIN = 0.3;
/** Quem já está no fundo se rearranja até um palmo, sem cair em cima do tiro. */
const ESCAPE_SHUFFLE = 0.5;
/** Medição de progresso: um passo por segundo, no mínimo, senão o caminho é outro. */
const PROBE_S = 1;
const PROBE_MIN = 0.15;
/** Tempo dando a volta no móvel antes de procurar outro destino. */
const ROUND_S = 1.2;
/** Passeio de verdade: ponto ao pé da pessoa não é destino. */
const MIN_STEP = 0.4;
/** Folga de parede: ninguém some dentro do reboco. */
const WALL_MARGIN = 0.55;
const BODY_CLEAR = 0.17;
const PUSH_RADIUS = 0.34;

/**
 * A gente que mora, atende e compra dentro das salas. A cadeia tem elenco próprio
 * (`JailSystem`); aqui são a casa, o comércio e o escritório. Cada papel estaciona em
 * frente de um móvel da planta e vaga em torno dele, do mesmo jeito iso que o resto do
 * mundo anda — um eixo por vez, porque o sprite só tem quatro direções.
 */
export class InteriorCrowdSystem {
  list: RoomOccupant[] = [];
  inside = false;
  private room: InteriorRoom | null = null;
  /** O elenco sobrevive à visita: sair e voltar pela porta não recontrata ninguém. */
  private casts = new Map<number, RoomOccupant[]>();
  private nextId = 91000;

  /** Abre a cortina de uma sala. A cadeia devolve false: lá quem manda é o JailSystem. */
  enter(room: InteriorRoom): boolean {
    if (room.kind === 'jail') {
      this.leave();
      return false;
    }
    this.room = room;
    this.inside = true;
    let cast = this.casts.get(room.id);
    if (!cast) {
      cast = this.build(room);
      this.casts.set(room.id, cast);
    }
    this.list = cast;
    return cast.length > 0;
  }

  leave() {
    this.inside = false;
    this.room = null;
    this.list = [];
  }

  /** Busca estável para o sprite: a fila encurta quando alguém morre, o id não. */
  byId(id: number): RoomOccupant | undefined {
    return this.list.find((o) => o.id === id);
  }

  private build(room: InteriorRoom): RoomOccupant[] {
    const taken = new Set<Furniture>();
    const cast: RoomOccupant[] = [];
    for (const spec of crowdRolesFor(room.kind)) {
      const anchor = spec.anchors
        .map((kind) => room.furniture.find((f) => f.kind === kind && !taken.has(f)))
        .find((f): f is Furniture => !!f);
      // Sem base possível (a sorveteria não tem cozinha) o papel não existe nesta sala.
      if (!anchor) continue;
      const spot = this.standPoint(anchor, room);
      if (!spot) continue;
      taken.add(anchor);
      const o: RoomOccupant = {
        ...createNPC(this.nextId++, spec.char, spot.x, spot.y, 'civ'),
        role: spec.role,
        baseX: spot.x,
        baseY: spot.y,
        roam: spec.roam,
        walkSpeed: spec.speed,
        tx: spot.x,
        ty: spot.y,
        wait: 0.6 + Math.random() * 2,
        panic: 0,
        remain: 0,
        rounding: 0,
        gx: spot.x,
        gy: spot.y,
        guard: 0,
      };
      o.dir = facingOf(room, spot);
      cast.push(o);
    }
    return cast;
  }

  /**
   * Onde o papel fica em pé: a frente do móvel primeiro, depois as laterais. Rejeita o
   * balcão e a porta, que são o ponto de apoio do jogador, não o dele. Se o móvel estiver
   * espremido por cadeiras e mesas, vale o chão livre mais perto dele — o papel não some
   * só porque a planta ficou apertada.
   */
  private standPoint(item: Furniture, room: InteriorRoom): { x: number; y: number } | null {
    const cx = item.x + item.w / 2;
    const cy = item.y + item.d / 2;
    const claimed = (x: number, y: number) =>
      Math.hypot(x - room.service.x, y - room.service.y) < 0.8 ||
      Math.hypot(x - room.exit.x, y - room.exit.y) < 0.8;
    const gap = 0.42;
    for (const [x, y] of [
      [cx, item.y + item.d + gap],
      [item.x + item.w * 0.25, item.y + item.d + gap],
      [item.x + item.w * 0.75, item.y + item.d + gap],
      [item.x - gap, cy],
      [item.x + item.w + gap, cy],
      [cx, item.y - gap],
    ]) {
      if (!claimed(x, y) && this.free(x, y, room)) return { x, y };
    }
    let best: { x: number; y: number } | null = null;
    let bestDistance = Infinity;
    for (let ox = -1.2; ox <= 1.21; ox += 0.3) {
      for (let oy = -1.2; oy <= 1.21; oy += 0.3) {
        const x = cx + ox;
        const y = cy + oy;
        const distance = Math.hypot(ox, oy);
        if (distance >= bestDistance || claimed(x, y) || !this.free(x, y, room)) continue;
        best = { x, y };
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Ponto livre: dentro da sala, fora de móvel, parede e da cabeça dos colegas. */
  private free(x: number, y: number, room: InteriorRoom): boolean {
    const W = room.map.worldW;
    const H = room.map.worldH;
    if (x < WALL_MARGIN || y < WALL_MARGIN || x > W - WALL_MARGIN || y > H - WALL_MARGIN) return false;
    return !room.map.staticColliders.some((c) =>
      x + BODY_CLEAR > c.x && x - BODY_CLEAR < c.x + c.width &&
      y + BODY_CLEAR > c.y && y - BODY_CLEAR < c.y + c.height);
  }

  update(dt: number, ctx: CrowdContext) {
    if (!this.inside || !this.room) return;
    const frame: Frame = {
      room: this.room,
      player: ctx.player,
      collision: ctx.collision,
      dt,
      heard: ctx.shot ? HEAR_SHOT : ctx.melee ? HEAR_MELEE : 0,
    };
    const keep: RoomOccupant[] = [];
    let killed = false;
    for (const o of this.list) {
      if (o.dead) {
        if (o.deathTimer < 0) {
          o.deathTimer = 0;
          o.blood = bloodStains(o.id, o.dir);
        }
        o.deathTimer += dt;
        killed = true;
        if (o.deathTimer < NPC_CORPSE_LIFETIME_S) keep.push(o);
        else ctx.notify();
        continue;
      }
      if (o.downTimer > 0) {
        o.downTimer = Math.max(0, o.downTimer - dt);
        o.state = 'knocked';
        o.anim = 'idle';
        o.speed = 0;
        o.panic = PANIC_S;
        keep.push(o);
        continue;
      }
      if (o.state === 'knocked') {
        o.state = 'idle';
        ctx.notify();
      }
      if (frame.heard > 0 &&
        Math.hypot(frame.player.x - o.x, frame.player.y - o.y) < frame.heard) o.panic = PANIC_S;
      const scared = o.panic > 0;
      if (scared) o.panic = Math.max(0, o.panic - dt);
      if (o.panic > 0) {
        this.flee(o, frame);
        // Uma volta de móvel pode custar um palmo; o chão inteiro já ganho no susto não.
        o.guard = Math.max(o.guard, Math.hypot(o.x - frame.player.x, o.y - frame.player.y));
      } else {
        if (scared) {
          // Passado o susto, a pessoa volta direto para o próprio canto; o passeio é depois.
          this.aim(o, o.baseX, o.baseY);
          o.guard = 0;
        }
        this.work(o, dt, frame);
      }
      this.animate(o, o.speed > 0, dt);
      keep.push(o);
    }
    // O rebanho: quem está perto de alguém em pânico pega o pânico junto.
    for (const o of keep) {
      if (o.dead || o.panic > 0) continue;
      if (keep.some((other) => other !== o && !other.dead && other.panic > 0 &&
        Math.hypot(other.x - o.x, other.y - o.y) < PANIC_SPREAD)) o.panic = PANIC_S * 0.7;
    }
    if (killed) {
      for (const o of keep) {
        if (!o.dead) o.panic = Math.max(o.panic, PANIC_S);
      }
      ctx.notify();
    }
    if (keep.length !== this.list.length) ctx.notify();
    this.list = keep;
    this.casts.set(frame.room.id, keep);
  }

  /** Trabalho: anda atrás de um ponto novo em volta da base e tira um tempo parado. */
  private work(o: RoomOccupant, dt: number, frame: Frame) {
    if (this.walk(o, o.walkSpeed, frame, () => this.pickTarget(o, frame))) return;
    // Parado fora do próprio canto não se descansa: anda até voltar para casa.
    if (Math.hypot(o.x - o.baseX, o.y - o.baseY) > o.roam) {
      if (Math.hypot(o.tx - o.x, o.ty - o.y) < 0.25) this.pickTarget(o, frame);
    } else {
      o.wait -= dt;
      if (o.wait <= 0) {
        this.pickTarget(o, frame);
        o.wait = 1.6 + Math.random() * 3.4;
      }
    }
    o.state = 'idle';
    o.anim = 'idle';
    o.speed = 0;
  }

  /** Correr: o canto mais distante do jogador, e ali a pessoa se encolhe até passar o susto. */
  private flee(o: RoomOccupant, frame: Frame) {
    if (Math.hypot(o.tx - o.x, o.ty - o.y) < 0.25) this.escape(o, frame);
    if (this.walk(o, FLEE_SPEED, frame, () => this.escape(o, frame), this.farCorner(frame))) return;
    o.state = 'fleeing';
    o.anim = 'idle';
    o.speed = 0;
    o.dir = deltaToDir(frame.player.x - o.x, frame.player.y - o.y);
  }

  /**
   * Fuga encalhada num móvel: o desvio é para o canto oposto ao jogador, nunca para o
   * meio da sala — senão quem corre de um tiro no centro acabaria correndo para ele.
   */
  private farCorner(frame: Frame): { x: number; y: number } {
    const { room, player } = frame;
    let best = { x: room.map.worldW / 2, y: room.map.worldH / 2 };
    let far = -1;
    for (const [x, y] of [[WALL_MARGIN, WALL_MARGIN], [room.map.worldW - WALL_MARGIN, WALL_MARGIN],
      [WALL_MARGIN, room.map.worldH - WALL_MARGIN], [room.map.worldW - WALL_MARGIN, room.map.worldH - WALL_MARGIN]]) {
      const distance = Math.hypot(x - player.x, y - player.y);
      if (distance > far) {
        far = distance;
        best = { x, y };
      }
    }
    return best;
  }

  /**
   * Para onde correr: varre o chão livre da sala, mede a distância até o jogador e sorteia
   * entre os empatados no fundo. Não basta o ponto ser longe -- a corrida também não pode
   * passar na frente do cano, nem perder o chão que este susto já ganhou.
   */
  private escape(o: RoomOccupant, frame: Frame) {
    const { room, player } = frame;
    const spots: { x: number; y: number; distance: number }[] = [];
    let far = 0;
    for (let x = 0.8; x <= room.map.worldW - 0.8; x += 0.45) {
      for (let y = 0.8; y <= room.map.worldH - 0.8; y += 0.45) {
        if (!this.free(x, y, room)) continue;
        const distance = Math.hypot(x - player.x, y - player.y);
        far = Math.max(far, distance);
        spots.push({ x, y, distance });
      }
    }
    const here = Math.hypot(o.x - player.x, o.y - player.y);
    // O fundo é o máximo já alcançado neste susto, não o pé de onde a pessoa está agora:
    // senão três voltas de mesa de meio palmo viram travessia da sala na direção do tiro.
    const own = Math.max(o.guard, here);
    const safe = (s: { x: number; y: number }) => this.lane(o.x, o.y, s.x, s.y, player) >= here - ESCAPE_SHUFFLE;
    // Todos fogem para longe, mas cada um para um canto diferente: senão correm ombro a ombro.
    let pool = spots.filter((s) =>
      s.distance >= Math.max(far - FLEE_TIE, own + ESCAPE_GAIN) && safe(s));
    // Sem fundo alcançável, vale o escorregão pela parede até o ponto mais distante que dá
    // para tocar sem passar na frente do cano. Plantado no canto não é fuga, é estátua.
    if (!pool.length) {
      const reachable = spots.filter((s) => s.distance >= own - ESCAPE_SHUFFLE && safe(s));
      let top = -Infinity;
      for (const s of reachable) top = Math.max(top, s.distance);
      pool = reachable.filter((s) => s.distance >= top - 0.4);
    }
    if (!pool.length) return;
    // Do que serve, o que dá para atravessar: destino atrás de um armário inteiro é corrida
    // que vira esfrega-esfrega na quina. O meio do caminho livre já diz muito.
    const open = pool.filter((s) => this.free((o.x + s.x) / 2, (o.y + s.y) / 2, room));
    if (open.length) pool = open;
    const spot = pool[Math.floor(Math.random() * pool.length)];
    this.aim(o, spot.x, spot.y);
  }

  /**
   * Quão perto do atirador a corrida chega: andar iso abre os dois eixos na mesma proporção
   * e faz a travessia sair diagonal, então a régua honesta é a linha reta até o destino.
   */
  private lane(x: number, y: number, tx: number, ty: number, player: Player): number {
    const dx = tx - x;
    const dy = ty - y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(x - player.x, y - player.y);
    const t = Math.max(0, Math.min(1, ((player.x - x) * dx + (player.y - y) * dy) / len2));
    return Math.hypot(x + dx * t - player.x, y + dy * t - player.y);
  }

  /** Aponta e zerou a régua: alvo novo é medida nova, senão o sondeo confunde troca com andar. */
  private aim(o: RoomOccupant, x: number, y: number) {
    o.tx = x;
    o.ty = y;
    o.remain = Math.hypot(x - o.x, y - o.y);
    o.stuckTimer = 0;
    o.rounding = 0;
  }

  /**
   * Um eixo por vez, como o resto do mundo iso. Eixo travado por móvel ou parede vira o
   * outro no mesmo tick, e na falta dos dois desvia pelo `detour`: é assim que a pessoa
   * contorna a mesa em vez de encalhar nela.
   */
  private walk(o: RoomOccupant, speed: number, frame: Frame, onStuck: () => void,
    detour?: { x: number; y: number }): boolean {
    if (o.rounding > 0) {
      o.rounding -= frame.dt;
      // Deu a volta: retoma o destino que tinha largado.
      if (o.rounding <= 0) this.aim(o, o.gx, o.gy);
    }
    const dx = o.tx - o.x;
    const dy = o.ty - o.y;
    if (Math.abs(dx) < 0.08 && Math.abs(dy) < 0.08) return false;
    const step = speed * frame.dt;
    const clamp = (v: number) => Math.sign(v) * Math.min(Math.abs(v), step);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const middle = detour ?? { x: frame.room.map.worldW / 2, y: frame.room.map.worldH / 2 };
    const aroundX = clamp(middle.x - o.x);
    const aroundY = clamp(middle.y - o.y);
    const tries: [number, number][] = horizontal
      ? [[clamp(dx), 0], [0, clamp(dy)], [0, aroundY]]
      : [[0, clamp(dy)], [clamp(dx), 0], [aroundX, 0]];
    for (const [mx, my] of tries) {
      if (mx === 0 && my === 0) continue;
      const bx = o.x;
      const by = o.y;
      o.x += mx;
      o.y += my;
      const body = { x: o.x, y: o.y, radius: GAME_CONFIG.NPC_RADIUS };
      frame.collision.resolveCircle(body, frame.room.map.staticColliders);
      o.x = body.x;
      o.y = body.y;
      if (Math.hypot(o.x - bx, o.y - by) > step * 0.35) {
        o.dir = deltaToDir(o.x - bx, o.y - by);
        o.state = o.panic > 0 ? 'fleeing' : 'walking';
        o.anim = 'walk';
        o.speed = speed;
        this.probe(o, frame, detour, onStuck);
        return true;
      }
      o.x = bx;
      o.y = by;
    }
    // Nem um eixo, nem o outro, nem o desvio: hora de dar a volta.
    o.stuckTimer += frame.dt;
    if (o.stuckTimer > 0.45) this.round(o, frame, detour, onStuck);
    return false;
  }

  /**
   * Deslizar por um móvel não encurta a linha reta: por isso a medição é lenta. Andar por
   * andar, sem nunca chegar, é o corpo empurrando a quina da mesa -- aí vem a volta.
   */
  private probe(o: RoomOccupant, frame: Frame, detour: { x: number; y: number } | undefined,
    onStuck: () => void) {
    o.stuckTimer += frame.dt;
    if (o.stuckTimer < PROBE_S) return;
    const remain = Math.hypot(o.tx - o.x, o.ty - o.y);
    const gained = o.remain - remain;
    o.stuckTimer = 0;
    o.remain = remain;
    if (gained < PROBE_MIN) this.round(o, frame, detour, onStuck);
  }

  /**
   * Preso num móvel: o desvio certo não é a linha reta até o destino (é justamente onde a
   * mesa está), é o lado livre mais perpendicular a ele. A pessoa dá a volta, retoma o
   * destino, e se ainda não deu é porque o destino mudou de vez.
   */
  private round(o: RoomOccupant, frame: Frame, detour: { x: number; y: number } | undefined,
    onStuck: () => void) {
    o.stuckTimer = 0;
    if (o.rounding > 0) {
      o.rounding = 0;
      onStuck();
      return;
    }
    const ring: { x: number; y: number; angle: number }[] = [];
    const floor = Math.max(o.guard, Math.hypot(o.x - frame.player.x, o.y - frame.player.y));
    for (let a = 0; a < 8; a++) {
      const angle = (a * Math.PI) / 4;
      for (const r of [0.6, 1.2]) {
        const x = o.x + Math.cos(angle) * r;
        const y = o.y + Math.sin(angle) * r;
        if (!this.free(x, y, frame.room)) continue;
        // Contornar não pode virar carga: quem foge não escolhe o lado de quem atirou.
        if (o.panic > 0 && Math.hypot(x - frame.player.x, y - frame.player.y) < floor - ESCAPE_SHUFFLE) continue;
        ring.push({ x, y, angle });
      }
    }
    if (!ring.length) {
      onStuck();
      return;
    }
    const goal = Math.atan2(o.ty - o.y, o.tx - o.x);
    const away = Math.atan2((detour?.y ?? frame.room.map.worldH / 2) - o.y,
      (detour?.x ?? frame.room.map.worldW / 2) - o.x);
    let best = ring[0];
    let bestScore = -Infinity;
    for (const s of ring) {
      // Perpendicular ao muro é contornar; puxado para o `detour` é sair do canto.
      const score = Math.abs(Math.sin(s.angle - goal)) * 1.5 + Math.cos(s.angle - away);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    o.gx = o.tx;
    o.gy = o.ty;
    this.aim(o, best.x, best.y);
    o.rounding = ROUND_S;
  }

  private pickTarget(o: RoomOccupant, frame: Frame) {
    for (let i = 0; i < 10; i++) {
      const x = o.baseX + (Math.random() * 2 - 1) * o.roam;
      const y = o.baseY + (Math.random() * 2 - 1) * o.roam * 0.8;
      if (Math.hypot(x - frame.player.x, y - frame.player.y) < 0.7) continue;
      // Precisa ter o que andar: um ponto ao pé da pessoa não é passeio.
      if (Math.hypot(x - o.x, y - o.y) < MIN_STEP) continue;
      if (this.free(x, y, frame.room)) {
        this.aim(o, x, y);
        return;
      }
    }
    // Posto apertado (o atendente atrás do balcão) não cabe no passeio de 0,4: um passo de
    // lado em frente ao balcão serve. Plantado no mesmo tijolo a pessoa é adereço, não gente.
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const x = o.baseX + Math.cos(angle) * o.roam;
      const y = o.baseY + Math.sin(angle) * o.roam * 0.8;
      if (Math.hypot(x - o.x, y - o.y) < 0.2) continue;
      if (this.free(x, y, frame.room)) {
        this.aim(o, x, y);
        return;
      }
    }
    // Sem sorte: a base é o destino, e ela sempre foi um ponto livre.
    this.aim(o, o.baseX, o.baseY);
  }

  private animate(o: RoomOccupant, moving: boolean, dt: number) {
    o.animTimer += dt * 1000;
    const frameMs = moving ? (o.panic > 0 ? 150 : 190) : 420;
    if (o.animTimer >= frameMs) {
      o.animTimer = 0;
      o.frame = (o.frame + 1) % 4;
    }
  }

  /**
   * Encostar num morador empurra os dois, como na rua. Os corpos voltam para o chão
   * livre mais próximo: sem isso um empurrão atravessaria a mesa.
   */
  separatePlayer(player: Player, collision: CollisionSystem) {
    const room = this.room;
    if (!this.inside || !room) return;
    let pushed = false;
    for (const o of this.list) {
      if (o.dead || o.state === 'knocked') continue;
      const dx = player.x - o.x;
      const dy = player.y - o.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.0001 && d2 < PUSH_RADIUS * PUSH_RADIUS) {
        const d = Math.sqrt(d2);
        const push = (PUSH_RADIUS - d) / d;
        player.x += dx * push * 0.6;
        player.y += dy * push * 0.6;
        o.x -= dx * push * 0.4;
        o.y -= dy * push * 0.4;
        pushed = true;
        if (o.panic <= 0) o.panic = 1.2;
      }
    }
    if (!pushed) return;
    const bodies = [{ body: player, radius: GAME_CONFIG.PLAYER_RADIUS },
      ...this.list.filter((o) => !o.dead)
        .map((o) => ({ body: o, radius: GAME_CONFIG.NPC_RADIUS }))];
    for (const { body, radius } of bodies) {
      const circle = { x: body.x, y: body.y, radius };
      collision.resolveCircle(circle, room.map.staticColliders);
      body.x = circle.x;
      body.y = circle.y;
    }
  }
}

/** O morador olha para dentro da sala, não para a parede atrás do móvel. */
function facingOf(room: InteriorRoom, spot: { x: number; y: number }): Dir4 {
  return deltaToDir(room.map.worldW / 2 - spot.x, room.map.worldH / 2 - spot.y);
}
