"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useGameStore = useGameStore;
const react_1 = require("react");
const Gps_1 = require("../world/Gps");
let state = {
    screen: 'menu',
    paused: false,
    mapOpen: false,
    shopOpen: false,
    departuresOpen: false,
    gameGen: 0,
    mapMarker: null,
    mapRoute: [],
    overlay: null,
};
const listeners = new Set();
let overlayTimer = null;
function emit() {
    for (const cb of listeners)
        cb();
}
function subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}
function getState() {
    return state;
}
function set(patch) {
    state = { ...state, ...patch };
    emit();
}
function startGame() {
    set({
        screen: 'playing',
        paused: false,
        mapOpen: false,
        shopOpen: false,
        departuresOpen: false,
        gameGen: state.gameGen + 1,
        mapMarker: null,
        mapRoute: [],
        overlay: null,
    });
}
function goToMenu() {
    set({
        screen: 'menu', paused: false, mapOpen: false, shopOpen: false, departuresOpen: false,
        mapMarker: null, mapRoute: [], overlay: null,
    });
}
function openShop() {
    if (state.screen !== 'playing' || state.shopOpen)
        return;
    set({ shopOpen: true, departuresOpen: false });
}
function closeShop() {
    if (!state.shopOpen)
        return;
    set({ shopOpen: false });
}
/** O telão e o balcão são cartões do mesmo balcão: um aberto fecha o outro. */
function openDepartures() {
    if (state.screen !== 'playing' || state.departuresOpen)
        return;
    set({ departuresOpen: true, shopOpen: false });
}
function closeDepartures() {
    if (!state.departuresOpen)
        return;
    set({ departuresOpen: false });
}
function showOverlay(kind) {
    if (overlayTimer)
        clearTimeout(overlayTimer);
    set({ overlay: kind });
    overlayTimer = setTimeout(() => {
        overlayTimer = null;
        set({ overlay: null });
    }, 2600);
}
function pause() {
    if (state.screen !== 'playing' || state.paused)
        return;
    set({ paused: true });
}
function resume() {
    if (!state.paused && !state.mapOpen)
        return;
    set({ paused: false, mapOpen: false });
}
function togglePause() {
    if (state.screen !== 'playing')
        return;
    if (state.mapOpen) {
        set({ mapOpen: false, paused: true });
        return;
    }
    set({ paused: !state.paused });
}
let pausedBeforeMap = false;
function openMap() {
    if (state.screen !== 'playing')
        return;
    pausedBeforeMap = state.paused;
    set({ mapOpen: true, paused: true });
}
function closeMap() {
    set({ mapOpen: false, paused: pausedBeforeMap });
}
/** Marca destino com rota já calculada (sem importar GameState → evita ciclo). */
function setMapDestination(x, y, route) {
    set({ mapMarker: { x, y }, mapRoute: route });
}
function setMapMarker(x, y) {
    set({ mapMarker: { x, y }, mapRoute: [] });
}
function clearMapMarker() {
    set({ mapMarker: null, mapRoute: [] });
}
function refreshMapRoute(map, fromX, fromY, driving) {
    const m = state.mapMarker;
    if (!m)
        return;
    const route = (0, Gps_1.buildGpsRoute)(map, fromX, fromY, m.x, m.y, driving);
    set({ mapRoute: route });
}
function useGameStore(selector) {
    return (0, react_1.useSyncExternalStore)(subscribe, () => selector(state), () => selector(state));
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
useGameStore.openDepartures = openDepartures;
useGameStore.closeDepartures = closeDepartures;
useGameStore.setMapMarker = setMapMarker;
useGameStore.setMapDestination = setMapDestination;
useGameStore.clearMapMarker = clearMapMarker;
useGameStore.refreshMapRoute = refreshMapRoute;
