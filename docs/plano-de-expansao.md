Continue o desenvolvimento do jogo isométrico estilo GTA já existente. **Não refaça nem remova as mecânicas que já estão funcionando.** Primeiro preserve tudo o que já foi implementado e, depois, evolua o projeto seguindo os pontos abaixo.

## 1. Relevo e topografia do mapa

O mapa precisa deixar de parecer completamente plano.

Trabalhe profundamente a topografia do mundo, criando:

* regiões com diferentes altitudes;
* morros;
* montanhas;
* vales;
* encostas;
* áreas baixas e áreas elevadas;
* desníveis naturais;
* estradas subindo e descendo;
* terrenos inclinados;
* planaltos;
* depressões;
* rios acompanhando o relevo;
* cachoeiras;
* cavernas;
* regiões montanhosas de difícil acesso.

O relevo deve ser **realista e integrado ao gameplay**, não apenas uma textura visual.

A sensação de profundidade do mundo deve ser muito maior. O jogador precisa perceber que está realmente explorando um território tridimensional, onde praticamente nenhuma área é perfeitamente plana.

Evite terrenos artificiais com elevações aleatórias. O relevo deve formar regiões coerentes, como aconteceria em um ambiente real.

## 2. Exploração

A exploração deve ser uma parte importante do jogo.

Criar áreas que recompensem o jogador por sair das regiões urbanas, incluindo:

* florestas densas;
* fazendas;
* sítios;
* áreas rurais;
* montanhas;
* cavernas;
* cachoeiras;
* áreas isoladas;
* estradas rurais;
* pequenas propriedades;
* regiões remotas;
* locais escondidos;
* interiores secretos;
* pontos de interesse espalhados pelo mapa.

O jogador deve ter motivos para explorar.

Não deixar o mapa parecer apenas uma cidade grande com áreas vazias ao redor. Criar diferentes ecossistemas e regiões com identidade própria.

## 3. Florestas e vegetação

Aumentar consideravelmente a presença de natureza no mapa.

Adicionar:

* florestas mais densas;
* árvores de diferentes tamanhos;
* arbustos;
* vegetação rasteira;
* áreas de mata fechada;
* árvores próximas a rios;
* vegetação em montanhas;
* vegetação rural;
* pequenas clareiras.

A floresta deve ter densidade suficiente para criar sensação de profundidade e isolamento.

## 4. Fazendas, sítios e área rural

Adicionar uma região rural realmente funcional.

Incluir:

* fazendas;
* sítios;
* plantações;
* celeiros;
* casas rurais;
* galpões;
* trabalhadores rurais;
* estradas de terra;
* cercas;
* currais;
* áreas de criação;
* equipamentos agrícolas;
* veículos rurais;
* animais.

Adicionar animais coerentes com cada região, como:

* cães;
* cavalos;
* vacas;
* galinhas;
* porcos;
* outros animais rurais.

Os animais também devem possuir comportamentos básicos, em vez de serem apenas objetos estáticos.

## 5. Clima e efeitos ambientais

Expandir bastante o sistema climático.

Adicionar diferentes condições climáticas:

* sol;
* chuva;
* chuva forte;
* tempestades;
* neblina;
* céu nublado;
* mudanças de iluminação;
* tempestades com raios.

A neblina utilizada durante carregamentos também precisa ser modificada.

### Neblina de carregamento

A neblina atual está muito escura.

Torná-la:

* mais clara;
* mais natural;
* menos agressiva visualmente;
* compatível com o horário;
* compatível com o clima da região.

Em determinados climas e condições de visibilidade, a neblina deve ser quase inexistente.

Evitar que a tela fique excessivamente escura durante carregamentos.

## 6. Raios e tempestades

Adicionar raios com comportamento mais natural.

Os raios podem:

* atingir árvores;
* causar incêndios;
* atingir estruturas;
* eventualmente atingir NPCs;
* eventualmente atingir o jogador.

Porém, **a probabilidade de um raio atingir diretamente uma pessoa deve ser extremamente baixa**, seguindo uma lógica plausível.

Um raio atingindo uma árvore pode iniciar um incêndio que se espalha dependendo das condições do ambiente.

Isso deve criar situações emergentes, mas sem transformar os raios em uma mecânica injusta ou excessivamente frequente.

## 7. Incêndios

Criar possibilidade de incêndios ambientais.

Por exemplo:

Raio → árvore atingida → árvore pega fogo → fogo se espalha para vegetação próxima.

O sistema pode considerar:

* vento;
* quantidade de vegetação;
* chuva;
* umidade;
* proximidade de outras árvores;
* estruturas próximas.

O objetivo é criar eventos naturais e imprevisíveis no mundo.

## 8. Saúde e itens de cura

Corrigir o comportamento dos itens de saúde.

Um item de cura **só deve poder ser coletado/utilizado quando a saúde do jogador não estiver cheia**.

Se a saúde estiver em 100%:

* não permitir pegar o item;
* ou deixar o item no mapa para ser coletado posteriormente.

Evitar que o jogador desperdice itens de cura quando já está com a vida cheia.

## 9. Interiores

Melhorar os interiores.

Os móveis estão grandes demais em relação ao personagem e ao ambiente.

Reduzir proporcionalmente o tamanho de:

* mesas;
* cadeiras;
* camas;
* armários;
* sofás;
* balcões;
* objetos decorativos;
* outros móveis.

Os interiores precisam parecer mais realistas e ter uma escala coerente com o personagem.

Adicionar também mais interiores exploráveis espalhados pelo mapa.

## 10. Sistema de prisão

Melhorar a lógica da cadeia.

### Policial

O policial responsável pela prisão **não pode atravessar as grades das celas**.

Ele deve respeitar a geometria física do ambiente.

Se estiver do lado de fora da cela, precisa permanecer do lado de fora.

### NPCs

Os NPCs também devem respeitar colisões e obstáculos.

Não permitir que NPCs simplesmente atravessem:

* carros;
* paredes;
* grades;
* objetos;
* outros obstáculos físicos.

## 11. Atropelamentos

Os NPCs devem poder ser atropelados por veículos.

Atualmente alguns NPCs parecem não possuir interação adequada com veículos.

Implementar:

* colisão física coerente;
* reação ao impacto;
* dano;
* possibilidade de queda;
* possibilidade de morte em impactos fortes.

Isso também deve funcionar para diferentes tipos de NPC.

## 12. Veículo da SWAT

Permitir que o veículo da SWAT possa entrar na cadeia quando isso fizer sentido para a situação.

O veículo deve respeitar colisões e o layout da prisão, mas não ficar bloqueado artificialmente pela entrada.

## 13. Sistema de prisão e perda de equipamentos

Ao ser preso, o jogador deve perder **todos os equipamentos ilegais ou carregados**, incluindo:

* armas;
* pistolas;
* rifles;
* munições;
* tacos;
* armas brancas;
* coletes;
* outros equipamentos.

Não deixar o taco ou outros equipamentos permanecerem no inventário depois da prisão.

Depois da prisão, o jogador deverá reconstruir seu equipamento.

## 14. Progressão dos equipamentos

As armas e equipamentos devem precisar ser encontrados ou comprados.

O jogador pode obter equipamentos através de:

* exploração;
* locais escondidos;
* missões;
* inimigos;
* lojas de armas;
* outros pontos de interesse.

Adicionar loja de armas funcional.

O colete também deve ser um equipamento que precisa ser adquirido/encontrado novamente depois de ser perdido.

A prisão, portanto, deve ter uma consequência real na progressão do jogador.

## 15. Veículos

Os veículos estão um pouco lentos atualmente.

Aumentar **moderadamente** a velocidade dos veículos.

Não tornar os veículos exageradamente rápidos.

O objetivo é fazer com que:

* carros pareçam mais rápidos;
* perseguições sejam mais interessantes;
* estradas longas sejam menos cansativas;
* aceleração e velocidade tenham uma sensação mais realista.

Ajustar também, se necessário:

* aceleração;
* frenagem;
* curva;
* aderência;
* comportamento em terrenos inclinados.

## 16. Tribos isoladas e áreas perigosas

Adicionar regiões extremamente isoladas do mapa.

Uma dessas regiões pode possuir uma tribo canibal que vive completamente afastada da civilização.

Essa região deve ser difícil de alcançar.

Não colocar a tribo simplesmente perto da cidade.

O jogador deve precisar atravessar diferentes áreas para chegar até ela, por exemplo:

cidade → estrada rural → floresta → montanhas → cavernas → região isolada.

Isso deve transformar a chegada ao local em uma verdadeira experiência de exploração.

### Tribo

Os NPCs dessa região devem possuir comportamento próprio e viver de maneira diferente dos NPCs urbanos.

Eles podem:

* patrulhar;
* perseguir o jogador;
* montar emboscadas;
* capturar o jogador;
* proteger seu território;
* utilizar armas próprias;
* possuir acampamentos.

## 17. Captura e minigame

Caso o jogador seja capturado pela tribo, criar uma situação especial.

O jogador pode ser levado para um local de sacrifício/prisão e precisar escapar através de um minigame.

O objetivo é fugir antes de ser morto/comido.

O minigame pode envolver:

* observar padrões;
* encontrar uma maneira de escapar;
* abrir uma trava;
* furtividade;
* escolher o momento correto;
* escapar sem chamar atenção.

Não tornar isso apenas uma tela de "Game Over".

O jogador deve ter uma chance real de escapar.

## 18. NPCs — grande melhoria

Trabalhar bastante nos NPCs.

Eles precisam deixar o mundo mais vivo.

Criar comportamentos diferentes para diferentes grupos:

### Civis

* andar;
* conversar;
* entrar em estabelecimentos;
* fugir de perigos;
* reagir a tiros;
* reagir a acidentes;
* reagir a tempestades;
* reagir a incêndios;
* entrar em veículos;
* sair de veículos.

### Policiais

* perseguir criminosos;
* procurar suspeitos;
* reagir a crimes;
* utilizar veículos;
* respeitar ambientes;
* respeitar portas, grades e obstáculos;
* trabalhar em conjunto.

### Trabalhadores rurais

* trabalhar nas fazendas;
* andar pelas plantações;
* cuidar dos animais;
* utilizar veículos rurais;
* permanecer em áreas rurais.

### Animais

Adicionar comportamentos básicos de animais:

* andar;
* fugir;
* perseguir;
* dormir;
* procurar comida;
* reagir a barulhos;
* reagir ao jogador;
* reagir a veículos;
* reagir a incêndios.

## 19. Mundo mais vivo

O objetivo geral dessa atualização é fazer o mundo parecer menos como um cenário e mais como um **ecossistema vivo**.

Eventos devem poder acontecer independentemente do jogador.

Exemplos:

* tempestade começando;
* raio atingindo árvore;
* incêndio começando;
* NPC fugindo de um incêndio;
* animais fugindo;
* policial perseguindo criminoso;
* acidente de trânsito;
* NPC sendo atropelado;
* chuva alterando a aparência do ambiente;
* regiões rurais funcionando;
* animais circulando;
* pessoas trabalhando;
* eventos acontecendo em regiões distantes.

## 20. Escala do mapa

Expandir o mapa consideravelmente.

Adicionar novas regiões sem simplesmente aumentar áreas vazias.

O mapa deve possuir:

* cidade;
* bairros;
* áreas industriais;
* estradas;
* áreas rurais;
* fazendas;
* florestas;
* montanhas;
* rios;
* cachoeiras;
* cavernas;
* regiões isoladas;
* áreas perigosas;
* locais secretos.

Cada região deve ter identidade visual e gameplay próprios.

## 21. Prioridade principal

A prioridade desta atualização é:

**profundidade + exploração + realismo + variedade + mundo vivo.**

O mapa não deve parecer um grande plano com objetos espalhados.

Quero que o jogador olhe para o mapa e tenha a sensação de que existe um mundo inteiro para explorar.

O relevo deve ser uma das principais características do novo mapa.

Criar áreas altas e baixas, montanhas, vales, cavernas, rios e cachoeiras para que a exploração tenha profundidade física e visual.

### Importante

Antes de implementar qualquer alteração:

1. analisar as mecânicas existentes;
2. preservar o que já funciona;
3. evitar quebrar sistemas existentes;
4. reutilizar sistemas quando possível;
5. implementar as novas funcionalidades de maneira modular;
6. manter boa performance;
7. evitar colocar milhares de objetos ou NPCs ativos simultaneamente sem necessidade;
8. utilizar LOD, pooling, streaming e outras técnicas quando necessário;
9. testar colisões, NPCs, veículos, clima e relevo juntos;
10. garantir que o jogo continue funcionando mesmo com o mapa significativamente maior.

A implementação deve ser feita de forma incremental, começando pelo **novo sistema de terreno/relevo e expansão do mapa**, depois clima/ambiente, exploração, NPCs, interiores, prisão, equipamentos e demais sistemas.
