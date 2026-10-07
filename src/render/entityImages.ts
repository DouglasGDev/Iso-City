import type { SkImage } from '@shopify/react-native-skia';
import {
  bombeiroCharacterKey, characterKey, policeCharacterKey, spriteKeyForVehicle,
} from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { solicitarSprite } from '../assets/SpriteRequests';
import { getGame } from '../game/GameState';
import { VEHICLE_DEFS } from '../data/vehicles';
import { isNpcVisible } from '../entities/NPC';
import { isAboard } from '../entities/Player';

/** Anotar o arquivo que a cena acabou de procurar e não achou; o desenho segue sem ele. */
function faltar(key: string): null {
  solicitarSprite(key);
  return null;
}

export function resolveEntityImage(id: string): SkImage | null {
  const game = getGame();
  if (id === 'player') {
    const p = game.player;
    if (isAboard(p)) return null;
    const dead = p.health <= 0 || p.state === 'dead';
    const key = characterKey(p.char, dead ? 'idle' : p.anim, p.direction, dead ? 0 : p.frame);
    return spriteStore[key] ?? faltar(key);
  }
  const [kind, idxStr] = id.split(':');
  const idx = Number(idxStr);
  // Preso, guarda e morador são NPCs comuns, endereçados pelo id (a fila encurta quando alguém morre).
  const npc = kind === 'npc' ? game.npcs[idx]
    : kind === 'inmate' ? game.jail.byId(idx)
      : kind === 'people' ? game.crowd.byId(idx) : null;
  if (npc) {
    if (!isNpcVisible(npc)) return null;
    // Damage systems may leave a walking frame behind. Keep a stable body image
    // through the fall/hold/fade, including the tick before deathTimer becomes 0.
    const anim = npc.dead ? 'idle' : npc.anim;
    const frame = npc.dead ? 0 : npc.frame;
    const key = npc.kind === 'cop' ? policeCharacterKey(anim, npc.dir, frame)
      : npc.kind === 'bombeiro' ? bombeiroCharacterKey(anim, npc.dir, frame)
        : characterKey(npc.char, anim, npc.dir, frame);
    return spriteStore[key] ?? faltar(key);
  }
  if (kind === 'veh') {
    const v = game.vehicles[idx];
    if (!v || v.state === 'destroyed') return null;
    const rotor =
      v.def.type === 'helicopter' ? ((v.animFrame === 1 || v.animFrame === 2 ? v.animFrame : 1) as 1 | 2) : 0;
    const key = spriteKeyForVehicle(v.def, v.color, v.dir, rotor);
    const base = spriteKeyForVehicle(v.def, v.color, v.dir, 0);
    return spriteStore[key] ?? spriteStore[base] ?? faltar(key);
  }
  if (kind === 'bus') {
    // A linha terrestre usa o ônibus que o jogo já tem: a arte existe, é licenciada e já entra
    // na fila de boot. O que a malha acrescenta é o horário, não um veículo novo.
    const u = game.transport.units[idx];
    if (!u || !u.live) return null;
    const key = spriteKeyForVehicle(VEHICLE_DEFS.bus_school, '', u.dir, 0);
    return spriteStore[key] ?? faltar(key);
  }
  return null;
}
