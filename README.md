# iso-city

MVP estilo GTA com visual isométrico, construído com React Native + Expo + Skia.

## Prompt original

Criar um jogável mobile estilo GTA (2D isométrico) usando os sprites Kenney fornecidos em `assets/sprites/`, com:

- Cidade gerada proceduralmente (quadras, ruas, calçadas, árvores, prédios, veículos estacionados)
- Jogador controlado por joystick virtual (andar e correr)
- NPCs andando pela cidade
- Entrar/sair de veículos
- Colisão com prédios, árvores e props sólidos
- Câmera isométrica seguindo o jogador
- HUD (vida, dinheiro, nível de procurado)

## Stack

- Expo SDK 54 (Expo Go)
- react-native 0.81.5, react 19.1.0
- @shopify/react-native-skia 2.2.12
- react-native-reanimated 4.1.7 + react-native-worklets 0.5.1
- react-native-gesture-handler 2.28.0
- typescript ~5.9.2 (não usar 7.x — quebra o Metro)

## Estrutura

```
src/
  assets/        Registro e carregamento dos sprites (manifesto gerado)
  audio/         sounds.ts (registro de SFX/ambient/loops) + SoundManager (unlock, canais)
  data/
    maps/city.ts Geração procedural da cidade (seed 1337, 112x112)
    vehicles.ts  Catálogo de veículos
    buildings.ts Catálogo de prédios/props
  entities/      Player, NPC, Vehicle, tipos
  game/          GameState (orquestrador fino), GameLoop, InputState, GameConfig
  render/        GameCanvas, GroundLayer, SortedWorldLayer, MarkerLayer, EntitySprite, camera
  systems/       Um sistema por mecânica (imports sem ciclo, contexto explícito):
                 MovementSystem, CollisionSystem, VehicleSystem, NPCSystem,
                 InteractionSystem, TrafficSystem, WantedSystem, StaminaSystem,
                 HealthSystem, CombatSystem, PoliceSystem, MissionSystem,
                 PickupSystem, DayNightSystem, WeatherSystem, DestructionSystem
  ui/            ControlTouch (multi-toque), VirtualJoystick, ActionButtons, HUD,
                 MiniMap/FullMap, RoundOverlay (PRESO/WASTED), PauseMenu, MainMenu
  world/         IsoUtils (projeção iso), Map (colisores, grafo rua/calçada, landmarks), Camera
tools/
  check/         Validação offline do mapa (compila src em CommonJS + roda no Node)
  generate-sfx.js Sintetiza WAVs faltantes (sirene, motor, explosão, soco, noite)
```

## Isometria (convenção crítica)

- Tile de mundo = 1x1; projeção: `screen = ((x-y)*64, (x+y)*32)`
- Imagem do tile (128x64): o vértice de cima do losango fica em `(sx, sy)` da projeção do canto do tile → desenhar em `x = sx - 64, y = sy`
- Entidades/prédios/props ancoram **centro-base**: `x = p.x - w/2, y = p.y - h` (p = projeção da posição no mundo)
- Profundidade (painters algo): `depth = x + y`

## O que já foi feito

### Implementação

- Cidade 27x27 com grade de ruas (X=6,13,20 / Y=6,13,20), 16 quarteirões com estilos (downtown, commercial, residential, park, industrial), prédios especiais (delegacia, hospital, igreja, posto, corpo de bombeiros etc.)
- 32 prédios + 57 props + 12 veículos estacionados + 14 NPCs com spawn nas calçadas
- Loop de jogo com passo fixo (60 FPS), câmera com lerp e lookahead
- Sistema de colisão AABB/círculo com resolução (prédios, props sólidos, bordas do mapa, separação player-NPC)
- Veículos com aceleração, freio, giro temporizado e entrada/saída (botão ENTRAR)
- HUD com vida, dinheiro e nível de procurado
- Validação offline do mapa: `npx tsc -p tools\check\tsconfig.json` + `node tools\check\check-map.cjs` (TUDO OK)

### Mecânicas estilo GTA (atualização profunda)

- **Cidade 112x112 procedural**: biomas (downtown/commercial/market/residential/suburb/park/industrial/docks), grade arterial com mãos-inglesas (sentido único), pontes, faixas de pedestre, estacionamento, grafismos de calçada
- **Landmarks reais** (`map.landmark('police' | 'hospital' | ...)`): esquadra e hospital viraram âncoras do ciclo de rodada (respawn na porta certa); igrejas, postos, clínicas e oficinas alimentam as missões
- **Combate melee**: botão de soco (arco + cooldown + knockback), civis no chão por alguns segundos, morte de NPC gera dinheiro dropado e sobe procurado
- **Polícia completa**: viaturas com sirene em loop (volume por distância), perseguem por grafo de ruas, batem de frente (ram), policiais a pé seguem e socam, **prisão** se ficar parado perto de cop → PRESO (perde dinheiro, acorda na esquadra); ao perder procurado, viaturas estacionam e cops viram civis
- **Rounded loop**: HP 0 → WASTED no hospital mais próximo (custo em dinheiro) / preso → PRESO na esquadra; invulnerabilidade breve pós-respawn
- **Sistema de missões**: entregas encadeadas (contato → coleta → entrega) com timer, recompensa escalando por chain, marcadores pulsantes no mundo e no minimapa
- **Proximidade/estrelas**: WantedSystem com decaimento pausado quando tem polícia perto; roubar viatura policial dá estrela na hora
- **Stamina**: barra de fôlego que drena em sprint e regenera; corrida trava quando acaba
- **Pickups**: dinheiro espalhado pela cidade (respawn), corações de vida, drops de NPCs
- **Dia/noite** (ciclo 5 min, tint azul à noite + laranja no crepúsculo, relógio no HUD, ambiente sonoro noturno) e **clima** (chuva procedural com som ambiente)
- **Destruição**: veículos com HP explodem em área (chain em outros veículos/NPCs), wreck no chão, ejecta o motorista
- **Screen shake** em impactos, explosões e socos
- **Áudio coerente**: canais de loop independentes (motor com volume por velocidade, sirene policial, ambiente dia/noite/chuva) + SFX sintetizados (`node tools/generate-sfx.js`) para o que faltava nos packs Kenney
- **Mobile/UX**: HUD com relógio, clima, stamina, estrela e cartão de missão; minimapa com destino de missão + distância; pausa silencia todos os loops; overlay PRESO/WASTED

### Correções (depois do downgrade para SDK 54)

- **Downgrade Expo 57 → 54** (pedido do usuário): expo 54.0.36, react 19.1.0, react-native 0.81.5, skia 2.2.12, reanimated 4.1.7, gesture-handler 2.28.0
- **"Reanimated is not installed!"**: o Expo Go do SDK 54 embute `react-native-worklets` 0.5.1 nativo; o reanimated 4.1.7 puxava worklets 0.8.3 → mismatch JS/native. Corrigido instalando `react-native-worklets@0.5.1` (deduplicado)
- **babel.config.js**: removido o plugin manual `react-native-reanimated/plugin` (o babel-preset-expo do SDK 54 adiciona o plugin de worklets automaticamente)
- **Joystick morto**: mutar `InputState` dentro do worklet do gesture não chega à thread JS → agora usa `runOnJS(setJoystickInput)` / `runOnJS(resetJoystickInput)`
- **Crash no CORRER**: chamada de callback JS (`onHoldChange`/`onPress`) dentro do worklet → envolvida em `runOnJS`
- **Player invisível**: EntitySprite não aplicava a conversão mundo→tela isométrica → corrigido com `useDerivedValue` + âncora centro-base
- **Piscar das entidades**: EntitySprite reescrito com props estáveis (só `id`), polling de imagem a 140ms e registro do shared value imediato; `resolveEntityImage` extraído para `src/render/entityImages.ts`
- **Ruas amontoadas ("um monte de quadrados")**: tiles do chão desenhados com o vértice do losango em `(sx, sy)` → `x = sx - 64, y = sy` no GroundLayer
- **Prédios/props desalinhados da colisão**: âncora corrigida para centro-base (`x = sx - w/2, y = sy - h`) no SortedWorldLayer
- **Flicker dos NPCs**: SortedWorldLayer reescrito — sem re-sort da árvore React a cada 100ms; estáticos memoizados em ordem estável e re-render de entidades só quando a estrutura muda (`entityVersion` + `useSyncExternalStore`: entrar/sair de veículo, NPC morrer)
- **Player "robótico"**: direção agora deriva de ângulo contínuo suavizado (`facingAngle` + `PLAYER_TURN_SPEED = 7 rad/s`, `rotateAngleToward`) em vez de snap por sinal a cada frame; sincronizado ao entrar em veículo

## O que falta corrigir / validar

O roteiro de evolução do mundo está em [`docs/plano-de-expansao.md`](docs/plano-de-expansao.md)
(21 seções escritas pelo autor: relevo, exploração, clima, fazenda, tribo isolada, cativeiro).
As seções 1 a 15 estão entregues; seguem abertos os incêndios ambientais (§7), a região isolada
com a tribo (§16), o minigame de fuga do cativeiro (§17), o mundo vivo (§18/§19) e a escala do
mapa (§20).

- **Testar no device**: obrigatório rodar `npx expo start --clear` e re-escanear o QR (bundle velho esconde todas as mudanças). Prioridades de teste: soco → reação de civis → chegada da polícia → prisão/respawn → missão com timer → chuva/noite → explosão de veículo
- **Oclusão por profundidade**: entidades sempre desenham **por cima** de prédios/props (jogador "atrás" de um prédio aparece na frente). Se incomodar, intercalar por profundidade usando `zIndex` (sem reordenar filhos React)
- **Armas de fogo**: adiado por falta de sprites adequados (o combate é melee); adicionar quando existirem assets de pistola/rifle coerentes com os chars Kenney
- **Rádio/estações**: não implementado (o jogo tem sirene/motor/ambiente, mas sem seletor de música)
- **Animação de corrida**: usa os mesmos frames do andar (não existem frames de corrida nos assets)
- **Preview estático do mapa**: útil criar uma ferramenta (ex.: `tools/check/preview`) que renderize o mapa num PNG/SVG com a mesma matemática dos layers

## Comandos

```bash
npm start                    # expo start (Expo Go no device)
npx expo start --clear       # limpa cache do Metro
npm run typecheck            # tsc --noEmit
npx expo export --platform android   # valida o bundle (Metro)
npx tsc -p tools\check\tsconfig.json; node tools\check\check-map.cjs   # valida o mapa
node tools/generate-sfx.js   # regenera os WAVs sintetizados em assets/Audio/generated
```

## Web: os patches são obrigatórios

Na web a Skia desenha com CanvasKit, que vive em memória wasm — o coletor de lixo do JS não
vê `SkPath`/`SkPaint`/`SkPicture`/`PictureRecorder` e nada é devolvido sozinho. O `postinstall`
(`npx patch-package`) conserta isso na própria biblioteca, em `lib/module` e `lib/commonjs`:

- `skia/web/JsiSkPaint.js` — `dispose()` devolve a tinta, que a classe não tinha;
- `sksg/Container.web.js` — um `PictureRecorder` por quadro gravado e apagado no mesmo lugar, e a
  picture substituída pelo `<Canvas>` é devolvida quando aview passa a apontar para a nova; o
  mapper parado no desmonte, e o `dispose()` do quadro anterior depois do desenho novo;
- `sksg/Recorder/DrawingContext.js`, `sksg/Recorder/Player.js` — o pool de tintas de cada
  gravação é reaproveitado e descartado junto dela;
- `specs/NativeSkiaModule.web.js` — a picture guardada para uma view ainda não registrada é
  consumida no registro, senão uma regravação posterior entrega uma alça morta ao canvas.

Sem esses patches o jogo abre e morre em minutos com `Aborted(). Build with -sASSERTIONS for
more info.` no navegador. `node tools/check/check-memory-browser.cjs` é a régua: mede o heap wasm
e a contagem de objetos vivos por classe e trava se qualquer um deles crescer.

## Licença

Código deste repositório: **MIT** (ver [`LICENSE`](LICENSE)). Pode usar, modificar e
redistribuir — inclusive comercialmente — desde que o aviso
`Copyright (c) 2026 DouglasGDev` e a licença continuem junto. Esse é o ponto do
projeto: livre com crédito.

Arte de terceiros não é coberta pela MIT: os sprites e áudios vêm de packs da Kenney
(CC0) e de outros conjuntos licenciados, cada um com seu crédito registrado junto ao
arquivo em `assets/`.
