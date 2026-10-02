import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { Asset } from 'expo-asset';
import { useImage, type SkImage } from '@shopify/react-native-skia';
import { ASSET_FILES } from '../assets/AssetManifest';
import { ASSETS_TO_LOAD } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';

/** Lote do download no aparelho: 543 arquivos de uma vez estouram o pedido ao Metro. */
const DOWNLOAD_BATCH = 24;
/** O `fromURI` do Skia rejeita por fora do nosso callback: sem esta janela a tela não levanta. */
const STALL_S = 12;
/**
 * Janela do contador de progresso. Decodificar é assíncrono e independente por arquivo; se cada
 * imagem chama `setState` no pai, a mesma raiz fecha um commit que agenda outro update 543 vezes
 * seguidas — é exatamente a sequência que o React denuncia como "Maximum update depth exceeded",
 * e o boot engole O(arquivos²) renders. O tique pinta a barra e nada mais.
 */
const PROGRESS_TICK_MS = 150;

/**
 * `memo` porque o pai repinta a cada tique de progresso: as props são uma string e um callback
 * estável, então uma imagem decodificada não pode reacender as outras 542 fileiras.
 */
const LoadSprite = memo(function LoadSprite({
  assetKey,
  onSettle,
}: {
  assetKey: string;
  onSettle: (key: string, img: SkImage | null) => void;
}) {
  const asset = Asset.fromModule(ASSET_FILES[assetKey]);
  const img = useImage(asset.localUri ?? asset.uri, () => onSettle(assetKey, null));
  useEffect(() => {
    if (img) onSettle(assetKey, img);
  }, [img, assetKey, onSettle]);
  return null;
});

export function SpriteProvider({ children }: { children: ReactNode }) {
  const total = ASSETS_TO_LOAD.length;
  const [downloaded, setDownloaded] = useState(false);
  const [files, setFiles] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [stalled, setStalled] = useState(false);
  const doneRef = useRef(new Set<string>());

  useEffect(() => {
    doneRef.current.clear();
    setLoadedCount(0);
    setFiles(0);
    setStalled(false);
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
        const batch = ASSETS_TO_LOAD.slice(i, i + DOWNLOAD_BATCH).map((key) => ASSET_FILES[key]);
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
    if (img) spriteStore[key] = img;
    // Só o ref: sem `setState` aqui, nenhuma imagem decodificada agenda update na raiz, e a barra
    // lê o tamanho do conjunto no seu próprio ritmo.
    doneRef.current.add(key);
  }, []);

  const ready = downloaded && total > 0;
  const finished = ready && (stalled || loadedCount >= total);

  useEffect(() => {
    if (!ready) return;
    const iv = setInterval(() => setLoadedCount(doneRef.current.size), PROGRESS_TICK_MS);
    return () => clearInterval(iv);
  }, [ready]);

  useEffect(() => {
    if (!ready || loadedCount >= total) return;
    const timer = setTimeout(() => setStalled(true), STALL_S * 1000);
    return () => clearTimeout(timer);
  }, [ready, loadedCount, total]);

  return (
    <>
      {ready && ASSETS_TO_LOAD.map((key) => (
        <LoadSprite key={key} assetKey={key} onSettle={onSettle} />
      ))}
      {!finished ? (
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
