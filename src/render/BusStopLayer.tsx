import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Path, Rect, RoundedRect, Skia, type SkPath } from '@shopify/react-native-skia';
import type { GameState } from '../game/GameState';
import type { TransportPlatform, TransportStation } from '../data/transport/types';
import { worldToScreen } from '../world/IsoUtils';
import { GAME_CONFIG } from '../game/GameConfig';
import { devolverNoTempoDoDesenho } from './SkiaLifetime';

/**
 * O ponto de ônibus é um lugar, não uma quadra de tinta. A cidade tem mais de cem paradas
 * servidas e a zona de embarque de cada uma (`TransportStation.ponto`, os tiles de passeio que
 * `noPonto()` aceita) mede sete a doze: pintá-los todos era espalhar mil losangos dourados pelo
 * calçamento, e o que sobrava para o jogador não era a informação "aqui o ônibus encosta" e sim
 * uma faixa amarela em cada rua. Fica UM bloco, no tile do marco — o pé do poste, onde a porta
 * se alinha — e o resto da zona continua aceitando embarque sem tinta nenhuma, porque ninguém
 * precisa estar em cima do losango para ser visto por ele. Nada aqui decide regra nenhuma, e é
 * por isso que a camada não pode ter um raio próprio.
 */
const PAINEL = '#b8913f';
const PAINEL_CLARO = '#d8b45c';
const BORDA = '#2c2a20';
const POSTE = '#8d97a0';
const POSTE_ESCURO = '#5b646c';
const PLACA = '#f2c14e';
/**
 * O concreto da plataforma: mais frio e mais claro que o dourado da marquise de rua, porque é
 * piso de pátio, não calçada de passeio, e o olho precisa separar "aqui o ônibus encosta" do
 * resto do asfalto da quadra.
 */
const PLATAFORMA = '#9fb3c6';
const PLATAFORMA_CLARA = '#cfe0ee';

/**
 * A marquise inteira num único caminho: seis losangos por calçada, redesenhados quando a
 * estação entra na tela e devolvidos quando ela sai. Um `Skia.Path.Make()` por tile por quadro
 * é memória wasm que a web não recupera, e um caminho compartilhado entre dois `<Path>` é a
 * última calçada pintada em todas as outras.
 */
const Zona = memo(function Zona({ tiles, cor, traço, game }: {
  tiles: { x: number; y: number }[]; cor: string; traço: string; game: GameState;
}) {
  const path = useMemo<SkPath>(() => {
    const p = Skia.Path.Make();
    for (const t of tiles) {
      const tx = Math.floor(t.x), ty = Math.floor(t.y);
      const cantos = [[tx + 0.08, ty + 0.08], [tx + 0.92, ty + 0.08],
        [tx + 0.92, ty + 0.92], [tx + 0.08, ty + 0.92]] as const;
      cantos.forEach(([x, y], i) => {
        const s = worldToScreen(x, y, game.map.heightSmoothAt(x, y));
        if (i === 0) p.moveTo(s.x, s.y);
        else p.lineTo(s.x, s.y);
      });
      p.close();
    }
    return p;
  }, [tiles, game]);
  // A marquise que está no `<Path>` agora: é a referência que decide se uma liberação adiada
  // vale. Devolvê-la enquanto ela desenha é o uso-after-free que a web paga em cada replay da
  // picture — e o remontar falso do StrictMode em desenvolvimento faz exatamente isso: o efeito
  // desmonta, monta de novo, e o mesmo caminho volta para a tela.
  const entregue = useRef<SkPath | null>(null);
  useEffect(() => {
    const anterior = entregue.current;
    entregue.current = path;
    if (anterior && anterior !== path) {
      devolverNoTempoDoDesenho(anterior, () => entregue.current === anterior);
    }
  }, [path]);
  useEffect(() => () => {
    const atual = entregue.current;
    entregue.current = null;
    if (atual) devolverNoTempoDoDesenho(atual, () => entregue.current === atual);
  }, []);
  return (
    <Group>
      <Path path={path} color={cor} opacity={0.6} />
      <Path path={path} color={traço} style="stroke" strokeWidth={1} opacity={0.45} />
    </Group>
  );
});

/**
 * Poste do ponto: o marco da calçada, não um pino de HUD. A placa traz o ônibus em traço —
 * nenhuma fonte vive no mundo isométrico (a Skia daqui desenha geometria, não texto), e uma
 * placa borrada serviria menos que um desenho que se lê de longe.
 */
const Parada = memo(function Parada({ x, y }: { x: number; y: number }) {
  return (
    <Group>
      <RoundedRect x={x - 6} y={y - 2.5} width={12} height={4} r={2} color="#1d2219" opacity={0.28} />
      <Rect x={x - 1.3} y={y - 30} width={2.6} height={28} color={POSTE} />
      <Rect x={x + 0.5} y={y - 30} width={0.8} height={28} color={POSTE_ESCURO} />
      <RoundedRect x={x - 8} y={y - 46} width={16} height={16} r={2.5} color={PLACA} />
      <RoundedRect x={x - 8} y={y - 46} width={16} height={16} r={2.5} color={BORDA}
        style="stroke" strokeWidth={1.2} />
      <RoundedRect x={x - 5.6} y={y - 42.4} width={11.2} height={5.4} r={1} color="#fff8e6" />
      <Rect x={x - 4.4} y={y - 41.6} width={2.4} height={2} color={PLACA} />
      <Rect x={x - 1.2} y={y - 41.6} width={2.4} height={2} color={PLACA} />
      <Rect x={x + 2} y={y - 41.6} width={2.4} height={2} color={PLACA} />
      <RoundedRect x={x - 4} y={y - 37.6} width={2.6} height={2.2} r={1} color={BORDA} />
      <RoundedRect x={x + 1.4} y={y - 37.6} width={2.6} height={2.2} r={1} color={BORDA} />
    </Group>
  );
});

/**
 * Os sete traços de um algarismo de placa de rodoviária. O mundo isométrico não tem fonte — a
 * Skia daqui desenha geometria — e um número escrito com retângulos é exatamente o display de
 * LED que pendurado sobre a baia em que se embarca. É por isso que a plataforma tem número
 * desenhado e não um ícone genérico: quem escolhe no telão escolhe um número.
 */
const TRAÇOS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};

const Algarismo = function Algarismo({ x, y, w, h, ch, cor }: {
  x: number; y: number; w: number; h: number; ch: string; cor: string;
}) {
  const t = Math.max(1.3, h * 0.15);
  const meio = (h - t) / 2;
  const caixa: Record<string, [number, number, number, number]> = {
    a: [x, y, w, t],
    f: [x, y + t, t, meio],
    b: [x + w - t, y + t, t, meio],
    g: [x, y + h / 2 - t / 2, w, t],
    e: [x, y + t + meio, t, meio],
    c: [x + w - t, y + t + meio, t, meio],
    d: [x, y + h - t, w, t],
  };
  return (
    <Group>
      {[...(TRAÇOS[ch] ?? '')].map((k) => {
        const r = caixa[k];
        return <Rect key={k} x={r[0]} y={r[1]} width={r[2]} height={r[3]} color={cor} />;
      })}
    </Group>
  );
};

/**
 * A placa da plataforma: o poste na beirada do passeio e o número aceso sobre ela. Fica no
 * marco da baia — o tile de passeio de frente para o ônibus que ali encosta — porque é de lá
 * que o número tem de ser lido por quem desce do hall e olha o pátio.
 */
const Placa = memo(function Placa({ x, y, número }: {
  x: number; y: number; número: number;
}) {
  const texto = String(número);
  const largura = texto.length * 8;
  return (
    <Group>
      <RoundedRect x={x - 6} y={y - 2.5} width={12} height={4} r={2} color="#1d2219" opacity={0.3} />
      <Rect x={x - 1.3} y={y - 34} width={2.6} height={32} color={POSTE} />
      <Rect x={x + 0.5} y={y - 34} width={0.8} height={32} color={POSTE_ESCURO} />
      <RoundedRect x={x - largura / 2 - 6} y={y - 58} width={largura + 12} height={22} r={3}
        color="#10161f" />
      <RoundedRect x={x - largura / 2 - 6} y={y - 58} width={largura + 12} height={22} r={3}
        color="#4d5a68" style="stroke" strokeWidth={1.4} />
      {[...texto].map((ch, i) => (
        <Algarismo key={i} ch={ch} cor="#ffd45c"
          x={x - largura / 2 + i * 8 + 1.5} y={y - 53} w={5} h={12} />
      ))}
    </Group>
  );
});

/**
 * O guichê: a cabine de bilhetes na ponta da plataforma, olhando para o asfalto em que o ônibus
 * encosta. Mora aqui porque a posição dele é deriva do berço — `TransportPlatform.guichê` é o
 * tile de passeio mais longe do encosto, o canto que não bloqueia embarque nenhum — e um guichê
 * desenhado em coordenada chutada seria banca vendendo passagem para uma plataforma que não
 * existe.
 */
const Guichê = memo(function Guichê({ x, y }: { x: number; y: number }) {
  return (
    <Group>
      <RoundedRect x={x - 11} y={y - 3} width={22} height={6} r={3} color="#161a12" opacity={0.32} />
      <RoundedRect x={x - 9} y={y - 24} width={18} height={22} r={2} color="#3f4a56" />
      <RoundedRect x={x - 10.5} y={y - 28} width={21} height={6} r={2} color={PLACA} />
      <Rect x={x - 6.5} y={y - 20} width={13} height={7} color="#10161f" />
      <Rect x={x - 6.5} y={y - 12} width={13} height={2.5} color="#c9d2da" />
      <Rect x={x + 5} y={y - 24} width={4} height={22} color="#2c343d" />
    </Group>
  );
});

/**
 * Uma plataforma do pátio: a faixa de passeio dela pintada, a placa com o número e o guichê na
 * beirada de dentro. As três coisas vêm da mesma lista que `naPlataforma()` lê, então o que se
 * pinta no chão é o que abre a porta — nem um tile a mais, nem um tile a menos.
 */
const Plataforma = memo(function Plataforma({ platform, game }: {
  platform: TransportPlatform; game: GameState;
}) {
  const marco = worldToScreen(platform.x, platform.y, game.map.heightSmoothAt(platform.x, platform.y));
  const guichê = worldToScreen(platform.guichê.x, platform.guichê.y,
    game.map.heightSmoothAt(platform.guichê.x, platform.guichê.y));
  return (
    <Group>
      <Zona tiles={platform.ponto} cor={PLATAFORMA} traço={PLATAFORMA_CLARA} game={game} />
      <Placa x={marco.x} y={marco.y} número={platform.número} />
      <Guichê x={guichê.x} y={guichê.y} />
    </Group>
  );
});

/**
 * O tile do marco, uma vez por estação. O `<Zona>` é memoizado pela identidade da lista: um
 * array novo a cada quadro seria um `SkPath` novo a cada quadro por cem e tantas paradas, e a
 * web não recupera essa memória.
 */
const BLOCOS = new WeakMap<TransportStation, { x: number; y: number }[]>();
function blocoDoMarco(st: TransportStation) {
  let bloco = BLOCOS.get(st);
  if (!bloco) {
    bloco = [{ x: Math.floor(st.x), y: Math.floor(st.y) }];
    BLOCOS.set(st, bloco);
  }
  return bloco;
}

/**
 * Calçadas que têm ônibus: o bloco do marco com o seu poste, e dentro da quadra exclusiva da
 * rodoviária as plataformas de embarque — cada uma com a sua faixa, o seu número e o seu
 * guichê. A zona visível corta antes da névoa, pelo mesmo motivo das outras camadas — a estação
 * do outro lado da cidade não precisa nem ser projetada.
 */
export function BusStopLayer({ game }: { game: GameState }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), GAME_CONFIG.ENTITY_CULL_MS);
    return () => clearInterval(iv);
  }, []);

  const view = game.fog.view(game);
  const pintadas: TransportStation[] = [];
  for (const st of game.transport.network.stations) {
    if (!st.lines.length) continue;
    if (!game.streaming.isInView(st.x, st.y)) continue;
    let esquerda = Infinity, direita = -Infinity, topo = Infinity, base = -Infinity;
    for (const t of blocoDoMarco(st)) {
      const c = worldToScreen(Math.floor(t.x) + 0.5, Math.floor(t.y) + 0.5,
        game.map.heightSmoothAt(Math.floor(t.x) + 0.5, Math.floor(t.y) + 0.5));
      esquerda = Math.min(esquerda, c.x - 64);
      direita = Math.max(direita, c.x + 64);
      topo = Math.min(topo, c.y - 34);
      base = Math.max(base, c.y + 34);
    }
    // O poste nasce do marco e sobe 46 pixels, e a placa da plataforma sobe 60: entram na caixa
    // senão somem antes da calçada, no limite da névoa.
    const marcos = [st, ...(st.platforms ?? []).map((id) => game.transport.network.platforms[id])];
    const altura = st.platforms?.length ? 62 : 48;
    for (const m of marcos) {
      const marco = worldToScreen(m.x, m.y, game.map.heightSmoothAt(m.x, m.y));
      esquerda = Math.min(esquerda, marco.x - 10) - 2;
      direita = Math.max(direita, marco.x + 10) + 2;
      topo = Math.min(topo, marco.y - altura) - 2;
      base = Math.max(base, marco.y + 8) + 2;
    }
    if (!game.fog.intersects(view, esquerda, topo, direita - esquerda, base - topo)) continue;
    pintadas.push(st);
  }

  return (
    <Group>
      {pintadas.map((st) => {
        if (st.platforms?.length) {
          // No pátio não há marquise única: o embarque é por baia, e o que se pinta é cada uma
          // delas, com o número que o telão anunciou.
          return (
            <Group key={`st${st.id}`}>
              {st.platforms.map((id) => (
                <Plataforma key={id} platform={game.transport.network.platforms[id]} game={game} />
              ))}
            </Group>
          );
        }
        const marco = worldToScreen(st.x, st.y, game.map.heightSmoothAt(st.x, st.y));
        return (
          <Group key={`st${st.id}`}>
            <Zona tiles={blocoDoMarco(st)} cor={PAINEL} traço={PAINEL_CLARO} game={game} />
            <Parada x={marco.x} y={marco.y} />
          </Group>
        );
      })}
    </Group>
  );
}
