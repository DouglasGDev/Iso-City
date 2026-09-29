import { registerRootComponent } from 'expo';
import { LoadSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

LoadSkiaWeb({ locateFile: () => '/canvaskit.wasm' }).then(() => {
  const App = require('./App').default;
  registerRootComponent(App);
});
