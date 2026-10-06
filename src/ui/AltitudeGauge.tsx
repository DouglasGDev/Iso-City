import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getGame } from '../game/GameState';
import { GAME_CONFIG } from '../game/GameConfig';
import { useControlInsets } from './useControlInsets';
import { readableShadow } from './textShadow';

/**
 * O altímetro.
 *
 * A coluna de ar existe no simulador, na câmera e na manta, e mesmo assim o piloto não tinha como
 * saber onde está dentro dela: subir sem leitura é subir num céu de papel — a nuvem chega quando
 * chega e não há como se preparar para ela. Este aparelho é a única janela do HUD para o que o
 * `AltitudeSystem` já publicou, e ele não decide nada: lê o instantâneo e desenha.
 *
 * A escala é a coluna INTEIRA, do chão ao teto do aparelho, e não uma janela que rola. É de
 * propósito: o que o piloto precisa ver não é "estou a 480 m", é "a manta está ali, no terço de
 * cima, e eu estou a dois dedos dela". Uma janela rolante apagaria justamente a única informação
 * que faz a travessia ser uma travessia — a distância que falta.
 *
 * Os metros são o `METROS_POR_ELEVACAO` aplicado sobre a cota; sem isso o aparelho leria um índice
 * de grade e se chamaria altitude por educação.
 */

/** Pixels de tela da coluna desenhada: o ar todo, do nível do mar ao teto do aparelho. */
const ALTURA_DA_COLUNA = 150;
const LARGURA_DA_COLUNA = 22;
/** Amostra a 10 Hz: é o ritmo do HUD, e a velocidade vertical precisa de dois pontos para existir. */
const AMOSTRA_MS = 100;

interface Leitura {
  /** Metros acima do chão que há debaixo do aparelho agora. */
  agl: number;
  /** Metro por segundo de subida, com a trepidação do quadro alisada. */
  vertical: number;
  /** Fração da coluna onde está a lataria. */
  marcador: number;
  /**
   * O lençol de nuvem no mesmo mapa da coluna. `opaca` é a cobertura do dia: sem nuvem nenhuma o
   * intervalo `inicio..fim` continua sendo publicado (é a cota TEÓRICA da base), e desenhá-lo
   * pintaria algodão num céu azul e escreveria "NUVEM 480 m" para uma tarde limpa.
   */
  manta: { inicio: number; fim: number; opaca: number };
  /** O relevo por baixo, na mesma escala. */
  chao: number;
  estado: string;
  vento: number;
  apertado: boolean;
}

function mede(cota: number, chao: number, vertical: number, a: {
  base: number; topo: number; teto: number; cobertura: number; dentro: number; acima: number;
  rarefeito: number; fechamento: number; ventoX: number; ventoY: number;
}): Leitura {
  const M = GAME_CONFIG.METROS_POR_ELEVACAO;
  const escala = Math.max(1, a.teto);
  const vento = Math.hypot(a.ventoX, a.ventoY) * M;
  const temManta = a.cobertura > 0.02;
  const abaixoDaManta = a.base - cota;
  const estado = a.dentro > 0.06 ? 'NA NUVEM'
    : a.acima > 0.5 ? 'SOBRE A MANTA'
      : a.rarefeito > 0.55 ? 'AR RARO'
        : !temManta ? 'SEM NUVEM'
          : abaixoDaManta > 0.2 ? `NUVEM ${Math.round(abaixoDaManta * M)} m`
            : a.fechamento > 0.4 ? 'DENTRO DA MANTA' : 'SEM NUVEM';
  return {
    agl: Math.max(0, (cota - chao) * M),
    vertical,
    marcador: Math.min(1, Math.max(0, cota / escala)),
    manta: {
      inicio: Math.min(1, Math.max(0, a.base / escala)),
      fim: Math.min(1, Math.max(0, a.topo / escala)),
      opaca: a.cobertura,
    },
    chao: Math.min(1, Math.max(0, chao / escala)),
    estado,
    vento,
    apertado: a.rarefeito > 0.55,
  };
}

export function AltitudeGauge({ visible }: { visible: boolean }) {
  const insets = useControlInsets();
  const game = getGame();
  const [leitura, setLeitura] = useState<Leitura | null>(null);
  const amostra = useRef<{ cota: number; t: number; vertical: number } | null>(null);

  useEffect(() => {
    if (!visible) {
      amostra.current = null;
      setLeitura(null);
      return;
    }
    const iv = setInterval(() => {
      const a = game.altitude.snapshot;
      const agora = Date.now();
      const anterior = amostra.current;
      // A velocidade vertical é uma diferença, e uma diferença de um quadro é ruído puro: o alfa
      // de 0,25 por amostra é o que faz a seta parar quieta quando o aparelho está parado.
      const cru = anterior ? (a.cota - anterior.cota) * 1000 / Math.max(1, agora - anterior.t) : 0;
      const suavizado = anterior ? anterior.vertical + (cru - anterior.vertical) * 0.25 : 0;
      amostra.current = { cota: a.cota, t: agora, vertical: suavizado };
      setLeitura(mede(a.cota, a.chao, suavizado, a));
    }, AMOSTRA_MS);
    return () => clearInterval(iv);
  }, [visible, game]);

  if (!visible || !leitura) return null;
  const sobe = leitura.vertical > 0.15;
  const desce = leitura.vertical < -0.15;
  const espessura = Math.max(0, leitura.manta.fim - leitura.manta.inicio);
  return (
    <View style={[styles.wrap, { top: insets.top + 52, right: insets.right }]}
      pointerEvents="none" testID="altitude-gauge" accessibilityLabel={`Altitude ${Math.round(leitura.agl)} metros`}>
      <Text style={[styles.numero, leitura.apertado && styles.apertado]} testID="altitude-m">
        {Math.round(leitura.agl / 10) * 10}
      </Text>
      <Text style={styles.unidade}>M AGL</Text>
      <View style={styles.corpo}>
        <View style={styles.coluna}>
          <View style={[styles.relevo, { height: Math.max(1, leitura.chao * ALTURA_DA_COLUNA) }]} />
          {espessura > 0.001 && leitura.manta.opaca > 0.02 ? (
            <View testID="altitude-manta" style={[styles.manta, {
              bottom: leitura.manta.inicio * ALTURA_DA_COLUNA,
              height: Math.max(2, espessura * ALTURA_DA_COLUNA),
              opacity: leitura.manta.opaca,
            }]} />
          ) : null}
          <View style={[styles.marcador, { bottom: leitura.marcador * ALTURA_DA_COLUNA - 3 }]} />
        </View>
        <View style={styles.letras}>
          <Text style={[styles.vertical, sobe && styles.sobe, desce && styles.desce]}>
            {sobe ? '▲' : desce ? '▼' : '—'}{Math.abs(leitura.vertical).toFixed(1)}
          </Text>
          <Text style={styles.vento}>{leitura.vento.toFixed(0)} m/s</Text>
        </View>
      </View>
      <Text style={[styles.estado, leitura.apertado && styles.apertado]} testID="altitude-estado">
        {leitura.estado}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', zIndex: 45, alignItems: 'flex-end', width: 74, gap: 2 },
  numero: { color: '#eff6f4', fontSize: 21, fontWeight: '900', letterSpacing: -0.5, lineHeight: 23 },
  apertado: { color: '#ffb547' },
  unidade: {
    color: '#8fa9b0', fontSize: 7, fontWeight: '800', letterSpacing: 1.4, marginTop: -3,
    ...readableShadow('#0a1219', 0, 1, 3),
  },
  corpo: { flexDirection: 'row-reverse', alignItems: 'flex-end', gap: 4 },
  coluna: {
    width: LARGURA_DA_COLUNA, height: ALTURA_DA_COLUNA, borderRadius: 5,
    borderWidth: 1, borderColor: '#4a6068', backgroundColor: 'rgba(8,14,22,0.62)',
    overflow: 'hidden', justifyContent: 'flex-end',
  },
  relevo: { width: '100%', backgroundColor: '#2c3a2e' },
  manta: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: 'rgba(232,240,252,0.82)',
  },
  marcador: {
    position: 'absolute', left: 1, right: 1, height: 5, borderRadius: 2,
    backgroundColor: '#ffd54a', borderWidth: 1, borderColor: '#3a2c07',
  },
  letras: { alignItems: 'flex-end', gap: 3, paddingBottom: 2 },
  vertical: { color: '#b1c4c7', fontSize: 10, fontWeight: '800' },
  sobe: { color: '#8fe3a0' },
  desce: { color: '#ff9a8a' },
  vento: { color: '#8fa9b0', fontSize: 9, fontWeight: '700' },
  estado: {
    color: '#dfe8f5', fontSize: 9, fontWeight: '900', letterSpacing: 0.4, textAlign: 'right',
    ...readableShadow('#0a1219', 0, 1, 3),
  },
});
