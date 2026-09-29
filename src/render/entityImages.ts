import type { SkImage } from '@shopify/react-native-skia';
import { characterKey, policeCharacterKey, spriteKeyForVehicle } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';
import { getGame } from '../game/GameState';
import { isNpcVisible } from '../entities/NPC';

export function resolveEntityImage(id: string): SkImage | null {
  const game = getGame();
  if (id === 'player') {
    const p = game.player;
    if (p.currentVehicleId !== null) return null;
    const dead = p.health <= 0 || p.state === 'dead';
    return spriteStore[characterKey(p.char, dead ? 'idle' : p.anim, p.direction, dead ? 0 : p.frame)] ?? null;
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
      : characterKey(npc.char, anim, npc.dir, frame);
    return spriteStore[key] ?? null;
  }
  if (kind === 'veh') {
    const v = game.vehicles[idx];
    if (!v || v.state === 'destroyed') return null;
    const rotor =
      v.def.type === 'helicopter' ? ((v.animFrame === 1 || v.animFrame === 2 ? v.animFrame : 1) as 1 | 2) : 0;
    const key = spriteKeyForVehicle(v.def, v.color, v.dir, rotor);
    return (
      spriteStore[key] ??
      spriteStore[spriteKeyForVehicle(v.def, v.color, v.dir, 0)] ??
      null
    );
  }
  return null;
}
