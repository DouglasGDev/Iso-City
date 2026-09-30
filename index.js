import { LogBox } from 'react-native';
import { registerRootComponent } from 'expo';
import App from './App';

// No Expo Go o LogBox nativo chega sem o método `show`: o primeiro warning ou erro do boot
// chama NativeLogBox.show() e derruba tudo em "show is not a function" — uma tela branca no
// lugar da falha real. O jogo tem casa própria para os erros (BootBoundary), então aqui o
// canal de log do app é fechado antes de qualquer módulo importar.
LogBox.ignoreAllLogs(true);

registerRootComponent(App);
