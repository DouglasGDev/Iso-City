import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Asset } from 'expo-asset';
import { useImage, type SkImage } from '@shopify/react-native-skia';
import { ASSET_FILES } from '../assets/AssetManifest';
import { ASSETS_TO_LOAD } from '../assets/AssetRegistry';
import { spriteStore } from '../assets/SpriteStore';

function LoadSprite({
  assetKey,
  onReady,
}: {
  assetKey: string;
  onReady: (key: string, img: SkImage) => void;
}) {
  const asset = Asset.fromModule(ASSET_FILES[assetKey]);
  const img = useImage(asset.localUri ?? asset.uri);
  useEffect(() => {
    if (img) onReady(assetKey, img);
  }, [img, assetKey, onReady]);
  return null;
}

export function SpriteProvider({ children }: { children: ReactNode }) {
  const total = ASSETS_TO_LOAD.length;
  const [loadedCount, setLoadedCount] = useState(0);
  const doneRef = useRef(new Set<string>());

  useEffect(() => {
    doneRef.current.clear();
    setLoadedCount(0);
  }, [total]);

  const onReady = useCallback((key: string, img: SkImage) => {
    if (doneRef.current.has(key)) return;
    doneRef.current.add(key);
    spriteStore[key] = img;
    setLoadedCount(doneRef.current.size);
  }, []);

  const ready = total > 0 && loadedCount >= total;

  return (
    <>
      {ASSETS_TO_LOAD.map((key) => (
        <LoadSprite key={key} assetKey={key} onReady={onReady} />
      ))}
      {!ready ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#ffd54a" />
          <Text style={styles.text}>
            Carregando cidade... {loadedCount}/{total}
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
