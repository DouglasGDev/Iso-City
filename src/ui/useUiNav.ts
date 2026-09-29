import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { HardwareMode } from '../game/InputState';
import { uiNav, type UiSurface, type UiSurfaceSpec } from './UiNav';

/**
 * Registra a tela aberta no navegador de menus. O spec fica num ref lido na hora da ação,
 * então o componente pode recriar a lista a cada render sem desregistrar nada.
 */
export function useUiSurface(surface: UiSurface, spec: UiSurfaceSpec) {
  const live = useRef(spec);
  live.current = spec;
  useEffect(() => {
    uiNav.open(surface, {
      items: () => live.current.items(),
      move: live.current.move,
      onAction: (action) => live.current.onAction?.(action),
      onBack: () => live.current.onBack?.(),
    });
    return () => uiNav.close(surface);
  }, [surface]);
}

/** Id da linha focada; muda com D-pad/setas e com toque, para a régua visual bater com a tela. */
export function useUiFocus(surface: UiSurface): string {
  return useSyncExternalStore(uiNav.subscribe, () => uiNav.focusId(surface), () => uiNav.focusId(surface));
}

/** A tela da frente, ou nenhuma: deixa a barra de dicas saber quando ela é de menu. */
export function useUiActive(): UiSurface | null {
  return useSyncExternalStore(uiNav.subscribe, () => uiNav.active(), () => uiNav.active());
}

/** 'touch' em celular: as telas só mostram dicas de tecla quando há teclado ou controle. */
export function useUiInputKind(): HardwareMode {
  return useSyncExternalStore(uiNav.subscribe, () => uiNav.inputKind(), () => uiNav.inputKind());
}

/** Toque e mouse focam a linha antes de agir. */
export function useUiPress(surface: UiSurface): (id: string) => void {
  return useCallback((id: string) => uiNav.step(surface, id), [surface]);
}
