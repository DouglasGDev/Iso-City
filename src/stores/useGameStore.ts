import { useSyncExternalStore } from 'react';
import { buildGpsRoute, type GpsPoint } from '../world/Gps';
import type { Map } from '../world/Map';

export type AppScreen = 'menu' | 'playing';

interface GameStoreState {
  screen: AppScreen;
  paused: boolean;
  mapOpen: boolean;
  /** Balcão de loja aberto: a simulação congela enquanto o jogador escolhe. */
  shopOpen: boolean;
  gameGen: number;
  mapMarker: { x: number; y: number } | null;
  mapRoute: GpsPoint[];
  overlay: 'busted' | 'wasted' | null;
}

let state: GameStoreState = {
  screen: 'menu',
  paused: false,
  mapOpen: false,
  shopOpen: false,
  gameGen: 0,
  mapMarker: null,
  mapRoute: [],
  overlay: null,
};
const listeners = new Set<() => void>();
let overlayTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getState(): GameStoreState {
  return state;
}

function set(patch: Partial<GameStoreState>) {
  state = { ...state, ...patch };
  emit();
}

function startGame() {
  set({
    screen: 'playing',
    paused: false,
    mapOpen: false,
    shopOpen: false,
    gameGen: state.gameGen + 1,
    mapMarker: null,
    mapRoute: [],
    overlay: null,
  });
}

function goToMenu() {
  set({ screen: 'menu', paused: false, mapOpen: false, shopOpen: false, mapMarker: null, mapRoute: [], overlay: null });
}

function openShop() {
  if (state.screen !== 'playing' || state.shopOpen) return;
  set({ shopOpen: true });
}

function closeShop() {
  if (!state.shopOpen) return;
  set({ shopOpen: false });
}

function showOverlay(kind: 'busted' | 'wasted') {
  if (overlayTimer) clearTimeout(overlayTimer);
  set({ overlay: kind });
  overlayTimer = setTimeout(() => {
    overlayTimer = null;
    set({ overlay: null });
  }, 2600);
}

function pause() {
  if (state.screen !== 'playing' || state.paused) return;
  set({ paused: true });
}

function resume() {
  if (!state.paused && !state.mapOpen) return;
  set({ paused: false, mapOpen: false });
}

function togglePause() {
  if (state.screen !== 'playing') return;
  if (state.mapOpen) {
    set({ mapOpen: false, paused: true });
    return;
  }
  set({ paused: !state.paused });
}

let pausedBeforeMap = false;

function openMap() {
  if (state.screen !== 'playing') return;
  pausedBeforeMap = state.paused;
  set({ mapOpen: true, paused: true });
}

function closeMap() {
  set({ mapOpen: false, paused: pausedBeforeMap });
}

/** Marca destino com rota já calculada (sem importar GameState → evita ciclo). */
function setMapDestination(x: number, y: number, route: GpsPoint[]) {
  set({ mapMarker: { x, y }, mapRoute: route });
}

function setMapMarker(x: number, y: number) {
  set({ mapMarker: { x, y }, mapRoute: [] });
}

function clearMapMarker() {
  set({ mapMarker: null, mapRoute: [] });
}

function refreshMapRoute(
  map: Map,
  fromX: number,
  fromY: number,
  driving: boolean,
) {
  const m = state.mapMarker;
  if (!m) return;
  const route = buildGpsRoute(map, fromX, fromY, m.x, m.y, driving);
  set({ mapRoute: route });
}

export function useGameStore<T>(selector: (s: GameStoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

useGameStore.getState = getState;
useGameStore.pause = pause;
useGameStore.resume = resume;
useGameStore.togglePause = togglePause;
useGameStore.startGame = startGame;
useGameStore.goToMenu = goToMenu;
useGameStore.showOverlay = showOverlay;
useGameStore.openMap = openMap;
useGameStore.closeMap = closeMap;
useGameStore.openShop = openShop;
useGameStore.closeShop = closeShop;
useGameStore.setMapMarker = setMapMarker;
useGameStore.setMapDestination = setMapDestination;
useGameStore.clearMapMarker = clearMapMarker;
useGameStore.refreshMapRoute = refreshMapRoute;
