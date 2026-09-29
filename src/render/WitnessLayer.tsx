import { useEffect, useState } from 'react';
import { Circle, Group, Rect } from '@shopify/react-native-skia';
import type { GameState } from '../game/GameState';
import { worldToScreen } from '../world/IsoUtils';

export function WitnessLayer({ game }: { game: GameState }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => refresh((n) => n + 1), 120);
    return () => clearInterval(timer);
  }, [game]);
  const view = game.fog.view(game);
  return <Group>{game.witnesses.calls.map((call) => {
    const npc = game.npcs.find((n) => n.id === call.npcId);
    if (!npc || npc.dead || call.radio || !npc.callingPolice) return null;
    const p = worldToScreen(npc.x, npc.y);
    if (!game.fog.intersects(view, p.x - 14, p.y - 65, 28, 65)) return null;
    const progress = Math.min(1, (call.elapsed - 0.7) / (call.duration - 0.7));
    return <Group key={call.npcId}>
      <Circle cx={p.x} cy={p.y - 55} r={12} color="#172737" />
      <Rect x={p.x - 4} y={p.y - 63} width={8} height={14} color="#ffc66d" />
      <Rect x={p.x - 2} y={p.y - 61} width={4} height={8} color="#172737" />
      <Rect x={p.x - 12} y={p.y - 40} width={24} height={3} color="#172737" />
      <Rect x={p.x - 12} y={p.y - 40} width={24 * progress} height={3} color="#ffc66d" />
    </Group>;
  })}</Group>;
}
