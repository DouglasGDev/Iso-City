import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Insets dos controles — longe da barra de navegação / gesture bar. */
export function useControlInsets() {
  const insets = useSafeAreaInsets();
  return useMemo(
    () => ({
      // Android 3-botões / gesture: nunca menos que 18–24
      bottom: Math.max(insets.bottom, 18) + 10,
      left: Math.max(insets.left, 6) + 12,
      right: Math.max(insets.right, 6) + 10,
      top: Math.max(insets.top, 6) + 6,
    }),
    [insets.bottom, insets.left, insets.right, insets.top],
  );
}
