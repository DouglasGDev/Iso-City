import { GAME_CONFIG } from '../game/GameConfig';
import type { Map } from '../world/Map';
import type { Player } from '../entities/Player';
import { sound } from '../audio/SoundManager';

export type MissionPhase = 'giver' | 'toPickup' | 'toDeliver' | 'break';

export interface MissionState {
  phase: MissionPhase;
  /** alvo atual (dá para o GPS/minimapa) */
  target: { x: number; y: number } | null;
  giver: { x: number; y: number };
  pickup: { x: number; y: number };
  deliver: { x: number; y: number };
  timeLeft: number;
  totalTime: number;
  reward: number;
  chain: number;
  completed: number;
}

const GIVER_KINDS = ['shop', 'autoshop', 'gasstation', 'clinic', 'firestation', 'hospital', 'church'] as const;

/**
 * Missões de entrega em cadeia: marcador no ponto de coleta, depois na
 * entrega. Corrente aumenta a recompensa; estourar o tempo zera a corrente.
 */
export class MissionSystem {
  state: MissionState;
  private breakTimer = 0;
  private sfxTimer = 0;

  constructor(private map: Map, private rng: () => number) {
    const anchor = this.pickAnchor(0, 0, 0) ?? { x: map.data.playerSpawn.x, y: map.data.playerSpawn.y };
    this.state = {
      phase: 'giver',
      target: anchor,
      giver: anchor,
      pickup: anchor,
      deliver: anchor,
      timeLeft: 0,
      totalTime: 0,
      reward: GAME_CONFIG.MISSION_BASE_REWARD,
      chain: 0,
      completed: 0,
    };
  }

  private anchors(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const l of this.map.landmarks) {
      if ((GIVER_KINDS as readonly string[]).includes(l.kind)) out.push(l.front);
    }
    if (out.length < 6) {
      // reforça com calçadas aleatórias se a cidade tiver poucas lojas
      const nodes = this.map.sidewalkNodes;
      for (let i = 0; i < 30 && nodes.length; i++) {
        out.push(nodes[Math.floor(this.rng() * nodes.length)]);
      }
    }
    return out;
  }

  private pickAnchor(fromX: number, fromY: number, minDist: number): { x: number; y: number } | null {
    const list = this.anchors();
    let best: { x: number; y: number } | null = null;
    for (let i = 0; i < 12 && list.length; i++) {
      const c = list[Math.floor(this.rng() * list.length)];
      const d = Math.hypot(c.x - fromX, c.y - fromY);
      if (d > minDist) return c;
      best = best ?? c;
    }
    return best;
  }

  update(dt: number, player: Player, onReward: (money: number) => void, canReachTarget = true) {
    const s = this.state;
    this.sfxTimer -= dt;

    if (s.phase === 'break') {
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) {
        s.phase = 'giver';
        const giver = this.pickAnchor(player.x, player.y, GAME_CONFIG.MISSION_MIN_DIST * 0.5);
        if (giver) {
          s.giver = giver;
          s.target = giver;
        }
      }
      return;
    }

    if (s.phase === 'giver') {
      const d = Math.hypot(s.giver.x - player.x, s.giver.y - player.y);
      if (canReachTarget && d < 1.3) {
        const pickup = this.pickAnchor(player.x, player.y, GAME_CONFIG.MISSION_MIN_DIST);
        if (!pickup) return;
        const dist = Math.hypot(pickup.x - player.x, pickup.y - player.y);
        s.pickup = pickup;
        s.target = pickup;
        s.phase = 'toPickup';
        s.totalTime = dist / GAME_CONFIG.MISSION_SPEED_ESTIMATE + GAME_CONFIG.MISSION_TIME_BUFFER_S;
        s.timeLeft = s.totalTime;
        s.reward = Math.round(
          GAME_CONFIG.MISSION_BASE_REWARD *
            (1 + s.chain * GAME_CONFIG.MISSION_CHAIN_MULT) *
            (1 + dist / 90),
        );
        if (this.sfxTimer <= 0) {
          sound.play('missionStart', 0.6);
          this.sfxTimer = 0.5;
        }
      }
      return;
    }

    s.timeLeft -= dt;
    if (s.timeLeft <= 0) {
      this.fail();
      return;
    }

    const goal = s.phase === 'toPickup' ? s.pickup : s.deliver;
    const d = Math.hypot(goal.x - player.x, goal.y - player.y);
    if (canReachTarget && d < 1.6) {
      if (s.phase === 'toPickup') {
        const deliver = this.pickAnchor(goal.x, goal.y, GAME_CONFIG.MISSION_MIN_DIST);
        if (!deliver) return;
        const legDist = Math.hypot(deliver.x - player.x, deliver.y - player.y);
        s.deliver = deliver;
        s.target = deliver;
        s.phase = 'toDeliver';
        s.totalTime = s.timeLeft + legDist / GAME_CONFIG.MISSION_SPEED_ESTIMATE;
        s.timeLeft = s.totalTime;
        sound.play('coin', 0.5);
      } else {
        this.succeed(onReward);
      }
    }
  }

  private succeed(onReward: (money: number) => void) {
    const s = this.state;
    onReward(s.reward);
    s.completed++;
    s.chain = Math.min(GAME_CONFIG.MISSION_CHAIN_MAX, s.chain + 1);
    sound.play('missionSuccess', 0.7);
    this.toBreak();
  }

  private fail() {
    const s = this.state;
    s.chain = 0;
    sound.play('missionFail', 0.6);
    this.toBreak();
  }

  private toBreak() {
    const s = this.state;
    s.phase = 'break';
    s.target = null;
    s.timeLeft = 0;
    this.breakTimer = GAME_CONFIG.MISSION_COOLDOWN_S;
  }
}
