import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState, BackHandler, StyleSheet, View, type AppStateStatus } from 'react-native';
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
import { getGame, resetGame } from './src/game/GameState';
import { loadSave, writeSave } from './src/game/SaveStorage';
import { useGameStore } from './src/stores/useGameStore';
import { resetActionInput, resetInputState, resetJoystickInput, resetVehicleArrows, setRunHeld } from './src/game/InputState';
import { sound } from './src/audio/SoundManager';
import { useHardwareInput } from './src/ui/useHardwareInput';
import { HardwareHints } from './src/ui/HardwareHints';

function useDriving(): boolean {
  useGameStore((s) => s.gameGen);
  const game = getGame();
  return useSyncExternalStore(
    (cb) => game.subscribeEntityChange(cb),
    () => game.player.currentVehicleId !== null,
    () => game.player.currentVehicleId !== null,
  );
}

function useFlying(): boolean {
  useGameStore((s) => s.gameGen);
  const game = getGame();
  return useSyncExternalStore(
    (cb) => game.subscribeEntityChange(cb),
    () => {
      const id = game.player.currentVehicleId;
      if (id === null) return false;
      return game.vehicles.find((v) => v.id === id)?.def.type === 'helicopter';
    },
    () => false,
  );
}

function quitApp() {
  BackHandler.exitApp();
}

/** Grava o snapshot atual. Só faz sentido com uma partida em curso e sem overlay de morte. */
function saveNow() {
  const ui = useGameStore.getState();
  if (ui.screen !== 'playing' || ui.overlay !== null) return;
  void writeSave(getGame().snapshot()).catch(() => undefined);
}

/** Volta ao menu salvando antes, para o CONTINUAR achar o progresso. */
function saveAndMenu() {
  saveNow();
  useGameStore.goToMenu();
}

export default function App() {
  const driving = useDriving();
  const flying = useFlying();
  const screen = useGameStore((s) => s.screen);
  const paused = useGameStore((s) => s.paused);
  const mapOpen = useGameStore((s) => s.mapOpen);
  const shopOpen = useGameStore((s) => s.shopOpen);
  const overlay = useGameStore((s) => s.overlay);
  const gameGen = useGameStore((s) => s.gameGen);
  const prev = useRef(driving);
  const suspended = screen !== 'playing' || paused || mapOpen || shopOpen || overlay !== null;
  const inputMode = useHardwareInput(suspended);

  useEffect(() => {
    const game = getGame();
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
        const game = getGame();
        game.paused = true;
        game.weapons.suspend();
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

  const playing = screen === 'playing';

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        <StatusBar hidden />
        <SpriteProvider>
          <View style={styles.container}>
            {playing && (
              <>
                <GameCanvas suspended={suspended} />
                {!suspended && inputMode === 'touch' ? (
                  <ControlTouch driving={driving} flying={flying}>
                    {driving && !flying ? <VehicleSteer /> : <VirtualJoystick />}
                    <ActionButtons />
                    <HUD />
                    <MiniMap />
                  </ControlTouch>
                ) : <>
                  <HUD />
                  <MiniMap />
                  {!suspended && inputMode !== 'touch' && <HardwareHints mode={inputMode} driving={driving} />}
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
              </>
            )}
            {screen === 'menu' && (
              <MainMenu
                onPlay={() => {
                  resetGame();
                  useGameStore.startGame();
                }}
                onContinue={() => {
                  void (async () => {
                    const save = await loadSave();
                    const game = resetGame();
                    if (save) game.applySave(save);
                    useGameStore.startGame();
                  })();
                }}
                onQuit={quitApp}
              />
            )}
          </View>
        </SpriteProvider>
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
});
