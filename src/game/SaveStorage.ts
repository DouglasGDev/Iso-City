import AsyncStorage from '@react-native-async-storage/async-storage';
import { exploredPercent, isSaveGame, type SaveGame } from './SaveGame';

const SAVE_KEY = 'iso-city.save.v1';

export function writeSave(save: SaveGame): Promise<void> {
  return AsyncStorage.setItem(SAVE_KEY, JSON.stringify(save));
}

export function clearSave(): Promise<void> {
  return AsyncStorage.removeItem(SAVE_KEY);
}

/** Lê e valida; devolve null se não há save, está corrompido ou é de outra versão. */
export async function loadSave(): Promise<SaveGame | null> {
  const raw = await AsyncStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSaveGame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function hasSave(): Promise<boolean> {
  return (await loadSave()) !== null;
}

export interface SaveSummary {
  x: number;
  y: number;
  money: number;
  exploredPercent: number;
}

/** Resumo para o botão CONTINUAR: onde o jogador parou e quanto do mapa ele viu. */
export async function readSummary(): Promise<SaveSummary | null> {
  const save = await loadSave();
  if (!save) return null;
  return {
    x: save.player.x,
    y: save.player.y,
    money: save.player.money,
    exploredPercent: exploredPercent(save.exploration),
  };
}
