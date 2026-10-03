import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { Asset } from 'expo-asset';
import { useImage, type SkImage } from '@shopify/react-native-skia';
import { ASSET_FILES } from '../assets/AssetManifest';
import { CARREGAMENTO, CARREGAMENTO_ESSENCIAL, RANGO_NA_FILA } from '../assets/AssetRegistry';
import { promoverDemandas } from '../assets/SpriteRequests';
import { spriteStore } from '../assets/SpriteStore';

/** Lote do download no aparelho: 543 arquivos de uma vez estouram o pedido ao Metro. */
const DOWNLOAD_BATCH = 24;
/**
 * Janela do que o Skia decodifica ao mesmo tempo. Sem janela, os 543 arquivos saem juntos:
 * na web eles disputam as seis conexões do navegador (e cada um custa a ida ao servidor de
 * desenvolvimento), e no aparelho são 543 decodificações brigando pelo mesmo quadro. A janela
 * avança no ritmo das chegadas, então o tráfego nunca para — só deixa de ser debandada.
 * O mesmo teto vale para a demanda da cena: o que ela pede entra na janela, não na frente dela.
 */
const LOTE = 12;
/**
 * Teto da tela de espera. O mundo abre com o que já chegou quando o prazo vence, porque a
 * última tela que o jogador quer ver é uma barra parada em 12/543 enquanto o servidor atende
 * um arquivo de cada vez.
 */
const ABERTURA_MS = 8000;
/**
 * Janela do contador de progresso. Decodificar é assíncrono e independente por arquivo; se cada
 * imagem chama `setState` no pai, a mesma raiz fecha um commit que agenda outro update 543 vezes
 * seguidas — é exatamente a sequência que o React denuncia como "Maximum update depth exceeded",
 * e o boot engole O(arquivos²) renders. O tique pinta a barra, abre o mundo e libera o lote.
 */
const PROGRESS_TICK_MS = 150;

/** O conjunto vazio compartilhado: um `new Set()` por render seria lixo a cada tique. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * `memo` porque o pai repinta a cada tique de progresso: as props são uma string, um booleano e
 * um callback estável, então uma imagem decodificada não pode reacender as outras 542 fileiras.
 */
const LoadSprite = memo(function LoadSprite({
  assetKey,
  ativo,
  onSettle,
}: {
  assetKey: string;
  ativo: boolean;
  onSettle: (key: string, img: SkImage | null) => void;
}) {
  const asset = Asset.fromModule(ASSET_FILES[assetKey]);
  // Fora da janela o source é `undefined`: o `useImage` não pede nada e a fileira fica parada
  // no lugar, sem desmontar — desmontar ia embora com a imagem que já estava no depósito.
  const img = useImage(ativo ? asset.localUri ?? asset.uri : undefined, () => onSettle(assetKey, null));
  useEffect(() => {
    if (img) onSettle(assetKey, img);
  }, [img, assetKey, onSettle]);
  return null;
});

export function SpriteProvider({ children }: { children: ReactNode }) {
  const total = CARREGAMENTO.length;
  const [downloaded, setDownloaded] = useState(false);
  const [files, setFiles] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [liberados, setLiberados] = useState(0);
  const [aberto, setAberto] = useState(false);
  const [demandados, setDemandados] = useState<ReadonlySet<string>>(EMPTY);
  const doneRef = useRef(new Set<string>());
  const promovidosRef = useRef(new Set<string>());
  const liberadosRef = useRef(0);

  useEffect(() => {
    doneRef.current.clear();
    promovidosRef.current.clear();
    liberadosRef.current = 0;
    setDemandados(EMPTY);
    setLoadedCount(0);
    setLiberados(0);
    setAberto(false);
    setFiles(0);
    setDownloaded(false);
    let alive = true;
    // No aparelho o PNG só vira arquivo local depois do download do expo-asset: sem essa
    // etapa o `localUri` fica nulo e o Skia recebe URL do Metro (ou android_res), que ele
    // não sabe ler — nada decodifica e a tela prende em 0/N. Na web o uri já é servido
    // pelo bundler, então não há o que baixar.
    if (Platform.OS === 'web') {
      setFiles(total);
      setDownloaded(true);
      return () => { alive = false; };
    }
    void (async () => {
      for (let i = 0; i < total; i += DOWNLOAD_BATCH) {
        const batch = CARREGAMENTO.slice(i, i + DOWNLOAD_BATCH).map((key) => ASSET_FILES[key]);
        // Um arquivo faltando não pode derrubar o resto da cidade.
        await Asset.loadAsync(batch).catch(() => undefined);
        if (!alive) return;
        setFiles(Math.min(total, i + DOWNLOAD_BATCH));
      }
      if (alive) setDownloaded(true);
    })();
    return () => { alive = false; };
  }, [total]);

  const onSettle = useCallback((key: string, img: SkImage | null) => {
    // O nulo também se grava: ele diz que o arquivo foi pedido e não veio, que é outra coisa
    // de "nunca foi pedido". Sem essa marca, o bake do chunk que espera por uma imagem quebrada
    // adiaria para sempre e o quarteirão inteiro ficaria invisível.
    spriteStore[key] = img;
    // Só o ref: sem `setState` aqui, nenhuma imagem decodificada agenda update na raiz, e a
    // barra, o portão e o lote lêem o tamanho do conjunto no ritmo do tique.
    doneRef.current.add(key);
  }, []);

  const ready = downloaded && total > 0;

  useEffect(() => {
    if (!ready) return;
    // O prazo é absoluto, contado uma vez quando a fila abre. Amarrá-lo ao progresso era o
    // erro: cada arquivo que chegava remarcava a ventana, e enquanto a debandada durasse o
    // mundo nunca abria — a tela ficava em "Carregando cidade..." até o último PNG.
    const prazo = Date.now() + ABERTURA_MS;
    const essencialPronto = () => {
      for (const key of CARREGAMENTO_ESSENCIAL) if (!doneRef.current.has(key)) return false;
      return true;
    };
    const iv = setInterval(() => {
      const feitos = doneRef.current.size;
      setLoadedCount(feitos);
      // A cena manda na frente da fila: o que o desenho pediu agora ocupa uma vaga do lote em
      // voo, em vez de se somar a ele. Sem isso, o prédio da esquina esperaria a volta do
      // carrossel alfabético inteira — o pedido chegava, mas disputava as seis conexões com o
      // lote, e o chunk da câmera continuava sem material.
      const emVoo = (k: string) => !doneRef.current.has(k);
      const tomadas = promoverDemandas(LOTE - [...promovidosRef.current].filter(emVoo).length);
      if (tomadas.length) {
        for (const k of tomadas) promovidosRef.current.add(k);
        setDemandados(new Set(promovidosRef.current));
      }
      // Só desconta do lote o pedido que ainda não estava nele: o que já está em voo não é
      // pressão nova, é o mesmo arquivo.
      const pressão = [...promovidosRef.current]
        .filter((k) => emVoo(k) && (RANGO_NA_FILA.get(k) ?? total) >= liberadosRef.current).length;
      liberadosRef.current = Math.min(total,
        Math.max(liberadosRef.current, LOTE + feitos - pressão));
      setLiberados(liberadosRef.current);
      if (feitos >= total || Date.now() >= prazo || essencialPronto()) setAberto(true);
    }, PROGRESS_TICK_MS);
    return () => clearInterval(iv);
  }, [ready, total]);

  return (
    <>
      {ready && CARREGAMENTO.map((key, i) => (
        <LoadSprite key={key} assetKey={key} ativo={i < liberados || demandados.has(key)}
          onSettle={onSettle} />
      ))}
      {!aberto ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#ffd54a" />
          <Text style={styles.text}>
            {ready ? `Carregando cidade... ${Math.min(loadedCount, total)}/${total}`
              : `Baixando cidade... ${files}/${total}`}
          </Text>
        </View>
      ) : (
        children
      )}
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#242a31',
    gap: 12,
  },
  text: {
    color: '#cfd8dc',
    fontFamily: 'monospace',
    fontSize: 14,
  },
});
