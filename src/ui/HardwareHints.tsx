import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getGame } from '../game/GameState';
import type { HardwareMode } from '../game/InputState';

export function HardwareHints({ mode, driving, flying = false }: {
  mode: Exclude<HardwareMode, 'touch'>;
  driving: boolean;
  flying?: boolean;
}) {
  const [prompt, setPrompt] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setPrompt(getGame().interiors.prompt(getGame().player)), 200);
    return () => clearInterval(timer);
  }, []);
  const pad = mode === 'gamepad';
  const text = pad
    ? flying ? 'LS voar · RT subir · LT descer · Y sair · Back mapa · Start pausa'
      : driving ? 'RT acelerar · LT frear · LS virar · B buzina · Y sair · Back mapa · Start pausa'
        : 'LS andar · Clique LS agachar · A correr · B pular · LT+RS mirar · RT atacar · X recarregar · LB anterior · RB próxima · Y interagir'
    : flying ? 'WASD voar · Espaço subir · Ctrl descer · E sair · M mapa · Esc pausa'
      : driving ? 'W acelerar · S frear/ré · A/D virar · H buzina · E sair · M mapa · Esc pausa'
        : 'WASD andar · C agachar · Shift correr · Space pular · Ctrl/clique esq. atirar · clique dir. mira · R recarga · Q anterior · Z próxima · E veículo · F interior';
  return <View style={styles.wrap} pointerEvents="none" testID="hardware-hints">
    {prompt && <Text style={styles.prompt}>{pad ? 'Y' : 'F'} · {prompt}</Text>}
    <Text style={styles.text}>{text}</Text>
  </View>;
}
const styles = StyleSheet.create({
  wrap: { position: 'absolute', bottom: 12, alignSelf: 'center', maxWidth: '90%', alignItems: 'center', gap: 6 },
  text: { color: '#c4ced5', fontSize: 10, backgroundColor: 'rgba(8,12,18,0.65)', padding: 8, borderRadius: 6 },
  prompt: { color: '#c8f1d9', fontSize: 12, backgroundColor: 'rgba(8,12,18,0.8)', padding: 8, borderRadius: 6 },
});
