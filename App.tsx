import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ActivityIndicator, AppState, BackHandler, InteractionManager, StyleSheet, Text, View,
  type AppStateStatus,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SpriteProvider } from './src/render/SpriteProvider';
import { GameCanvas } from './src/render/GameCanvas';
import { VirtualJoystick } from './src/ui/VirtualJoystick';
import { VehicleSteer } from './src/ui/VehicleSteer';
import { ActionButtons } from './src/ui/ActionButtons';
import { ControlTouch } from './src/ui/ControlTouch';
import { HUD } from './src/ui/HUD';
import { MiniMap, FullMap } from './src/ui/MiniMap';
import { RoundOverlay } from './src/ui/RoundOverlay';
import { ShopMenu } from './src/ui/ShopMenu';
import { PauseMenu } from './src/ui/PauseMenu';
import { MainMenu } from './src/ui/MainMenu';
import { getGame, peekGame, resetGame } from './src/game/GameState';
import { loadSave, writeSave } from './src/game/SaveStorage';
import type { SaveGame } from './src/game/SaveGame';
import { useGameStore } from './src/stores/useGameStore';
import { resetActionInput, resetInputState, resetJoystickInput, resetVehicleArrows, setRunHeld } from './src/game/InputState';
import { sound } from './src/audio/SoundManager';
import { useHardwareInput } from './src/ui/useHardwareInput';
import { HardwareHints } from './src/ui/HardwareHints';

/**
 * A cidade só existe depois do PLAY. `generateCity` + grafos do Map são centenas de
 * milhares de tiles de JS puro: no aparelho isso no render do menu segura o thread da
 * tela de boot e o app congela antes de qualquer Spinner aparecer.
 */
function useBooted(playing: boolean, gameGen: number) {
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef<SaveGame | null>(null);
  /** Pediu uma partida nova (ou um CONTINUAR): vale reconstruir depois do paint. */
  const arm = (save: SaveGame | null) => {
    saveRef.current = save;
    setError(null);
    setBooted(false);
  };
  useEffect(() => {
    if (!playing || booted) return;
    const task = InteractionManager.runAfterInteractions(() => {
      try {
        const game = resetGame();
        if (saveRef.current) game.applySave(saveRef.current);
        saveRef.current = null;
        setBooted(true);
      } catch (err) {
        // Sem isto o throw cai no LogBox nativo e some atrás do "show is not a
        // function"; com o texto na tela dá para ler o que quebrou no aparelho.
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => task.cancel();
  }, [playing, booted, gameGen]);
  return { booted, arm, error };
}

function useDriving(live: boolean): boolean {
  const game = live ? getGame() : null;
  return useSyncExternalStore(
    (cb) => (game ? game.subscribeEntityChange(cb) : () => undefined),
    () => game !== null && game.player.currentVehicleId !== null,
    () => game !== null && game.player.currentVehicleId !== null,
  );
}

function useFlying(live: boolean): boolean {
  const game = live ? getGame() : null;
  return useSyncExternalStore(
    (cb) => (game ? game.subscribeEntityChange(cb) : () => undefined),
    () => {
      if (!game) return false;
      const id = game.player.currentVehicleId;
      if (id === null) return false;
      return game.vehicles.find((v) => v.id === id)?.def.type === 'helicopter';
    },
    () => false,
  );
}

/**
 * Sem este casaco, um erro de render no aparelho cai no LogBox nativo — que em Expo Go
 * chama NativeLogBox.show() e morre em "show is not a function", escondendo a falha real
 * atrás de uma tela branca. Aqui o texto aparece na própria tela.
 */
class BootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.loading}>
        <Text style={styles.errorTitle}>O jogo não conseguiu iniciar</Text>
        <Text style={styles.errorText}>{this.state.error.message}</Text>
      </View>
    );
  }
}

function quitApp() {
  BackHandler.exitApp();
}

/** Grava o snapshot atual. Só faz sentido com uma partida em curso e sem overlay de morte. */
function saveNow() {
  const ui = useGameStore.getState();
  const game = peekGame();
  if (ui.screen !== 'playing' || ui.overlay !== null || !game) return;
  void writeSave(game.snapshot()).catch(() => undefined);
}

/** Volta ao menu salvando antes, para o CONTINUAR achar o progresso. */
function saveAndMenu() {
  saveNow();
  useGameStore.goToMenu();
}

export default function App() {
  const screen = useGameStore((s) => s.screen);
  const paused = useGameStore((s) => s.paused);
  const mapOpen = useGameStore((s) => s.mapOpen);
  const shopOpen = useGameStore((s) => s.shopOpen);
  const overlay = useGameStore((s) => s.overlay);
  const gameGen = useGameStore((s) => s.gameGen);
  const playing = screen === 'playing';
  const { booted, arm, error } = useBooted(playing, gameGen);
  const driving = useDriving(booted);
  const flying = useFlying(booted);
  const prev = useRef(driving);
  const suspended = !booted || screen !== 'playing' || paused || mapOpen || shopOpen || overlay !== null;
  const inputMode = useHardwareInput(suspended);

  useEffect(() => {
    const game = peekGame();
    if (!game) return;
    game.paused = suspended;
    if (suspended) {
      resetActionInput();
      resetJoystickInput();
      resetVehicleArrows();
      setRunHeld(false);
      game.weapons.suspend();
      game.suspendEnvironment();
    }
  }, [suspended, gameGen]);

  useEffect(() => {
    const onAppState = (state: AppStateStatus | null) => {
      const active = state === null || state === 'active';
      sound.setActive(active);
      if (!active) {
        resetInputState();
        const game = peekGame();
        if (game) {
          game.paused = true;
          game.weapons.suspend();
        }
        useGameStore.pause();
        // Sair para home/recents: autosave para o progresso não se perder.
        saveNow();
      }
    };
    const sub = AppState.addEventListener('change', onAppState);
    onAppState(AppState.currentState);
    sound.init();
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => undefined);
    return () => {
      sub.remove();
      sound.setActive(false);
      void ScreenOrientation.unlockAsync().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const s = useGameStore.getState();
      if (s.screen === 'menu') {
        quitApp();
        return true;
      }
      if (s.mapOpen) {
        useGameStore.closeMap();
        return true;
      }
      if (s.shopOpen) {
        useGameStore.closeShop();
        return true;
      }
      if (s.paused) {
        useGameStore.resume();
        return true;
      }
      useGameStore.pause();
      return true;
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (prev.current !== driving) {
      prev.current = driving;
      resetJoystickInput();
      resetVehicleArrows();
      setRunHeld(false);
    }
  }, [driving]);

  const live = playing && booted;

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <StatusBar hidden />
        <BootBoundary>
          <View style={styles.container}>
            {playing && !booted && (
              <View style={styles.loading}>
                {error ? <Text style={styles.errorTitle}>A cidade não pôde ser gerada</Text>
                  : <ActivityIndicator size="large" color="#ffd54a" />}
                <Text style={styles.loadingText}>{error ?? 'Gerando a cidade...'}</Text>
              </View>
            )}
            {/* Os sprites só fazem sentido com uma cidade: no menu o aparelho não tem por
                que baixar e decodificar 706 PNGs antes de deixar ver o PLAY. */}
            {live && (
              <SpriteProvider>
                <GameCanvas suspended={suspended} />
                {!suspended && inputMode === 'touch' ? (
                  <ControlTouch driving={driving} flying={flying}>
                    {driving && !flying ? <VehicleSteer /> : <VirtualJoystick />}
                    <ActionButtons flying={flying} />
                    <HUD />
                    <MiniMap />
                  </ControlTouch>
                ) : <>
                  <HUD />
                  <MiniMap />
                  {!suspended && inputMode !== 'touch' && <HardwareHints mode={inputMode} driving={driving} flying={flying} />}
                </>}
                <RoundOverlay />
                <PauseMenu
                  visible={paused && !mapOpen}
                  onResume={() => useGameStore.resume()}
                  onSave={saveNow}
                  onMap={() => useGameStore.openMap()}
                  onMainMenu={saveAndMenu}
                  onQuit={quitApp}
                />
                {mapOpen && <FullMap onClose={() => useGameStore.closeMap()} />}
                <ShopMenu />
              </SpriteProvider>
            )}
            {screen === 'menu' && (
              <MainMenu
                onPlay={() => {
                  arm(null);
                  useGameStore.startGame();
                }}
                onContinue={() => {
                  void (async () => {
                    arm(await loadSave());
                    useGameStore.startGame();
                  })();
                }}
                onQuit={quitApp}
              />
            )}
          </View>
        </BootBoundary>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#242a31',
  },
  container: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#cfd8dc',
    fontFamily: 'monospace',
    fontSize: 14,
  },
  errorTitle: {
    color: '#ffd54a',
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: '700',
  },
  errorText: {
    color: '#cfd8dc',
    fontFamily: 'monospace',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
});
