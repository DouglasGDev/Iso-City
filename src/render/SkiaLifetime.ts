import { Platform } from 'react-native';

/**
 * Ciclo de vida de objeto Skia na web, num lugar só.
 *
 * O `GroundLayer` chegou a essa regra depois de estourar o heap do CanvasKit com
 * `Aborted()` no meio de uma corrida de carro: lá, um `SkPath`/`SkPicture`/`SkVertices`
 * é memória wasm que o coletor do JavaScript não enxerga, e nada disso é devolvido ao
 * desmontar o componente. O `SortedWorldLayer` tem o mesmo problema em escala maior
 * quando o mundo passa a ser carregado por chunk: um chunk que sai da área de streaming
 * leva sombras de contato consigo, e essas sombras são exatamente os objetos que a web
 * precisa que a gente devolva.
 *
 * No aparelho o mesmo objeto é refcountado pelo C++ da picture, e descartar daqui seria
 * uso-after-free na thread de raster que ninguém tem como testar — por isso o `Platform.OS`
 * não é decoração em nenhuma das duas funções abaixo.
 */
const devolvidas = new WeakSet<object>();

export function liberarWeb(obj: { dispose?: () => void } | null | undefined): void {
  if (Platform.OS !== 'web' || !obj) return;
  // Em desenvolvimento o React monta, desmonta e monta de novo cada efeito, e sem a trava
  // o segundo `dispose()` cairia sobre uma alça já morta: o CanvasKit responde BindingError.
  if (devolvidas.has(obj)) return;
  devolvidas.add(obj);
  obj.dispose?.();
}

/**
 * Devolve o objeto no tempo do desenho, não no tempo do React.
 *
 * O `<Canvas>` da web regrava a lista de comandos a cada quadro — a câmera é um shared
 * value, então o mapper repassa o replay sem parar, e cada replay chama `drawPicture` /
 * `drawPath` sobre o objeto que o nó apontava *naquele* instante. Um `dispose()` no efeito
 * passivo cai depois do commit, mas a fila de desenhos ainda tem o quadro anterior dentro,
 * e ele lê uma alça morta. Contar quadros no relógio que desenha (o mesmo
 * `requestAnimationFrame` do `<Canvas>`) é a única margem que existe: quando o último passo
 * dispara, todo desenho enfileirado antes da troca já rodou.
 *
 * `aindaViva` aborta a liberação: é o caso do efeito falso de desmontar/remontar do React,
 * em que o objeto que saiu voltou para a tela sem nunca ter parado de desenhar.
 */
const QUADROS_DE_MARGEM = 3;
export function devolverNoTempoDoDesenho(
  obj: { dispose?: () => void },
  aindaViva: () => boolean = () => false,
): void {
  if (Platform.OS !== 'web') return;
  let faltam = QUADROS_DE_MARGEM;
  const passo = () => {
    if (aindaViva()) return;
    if (--faltam > 0) {
      requestAnimationFrame(passo);
      return;
    }
    liberarWeb(obj);
  };
  requestAnimationFrame(passo);
}
