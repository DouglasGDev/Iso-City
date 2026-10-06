import type { CharId } from '../entities/types';
import type { NPCKind } from '../entities/NPC';
import type { InteriorKind } from '../systems/InteriorSystem';

/**
 * Quem vive ou trabalha dentro de uma sala. Cada papel se posta em frente a um tipo de
 * móvel da própria planta (`InteriorSystem.makeRoom`), então a pessoa acompanha o layout
 * sem coordenada duplicada: mexeu no balcão, o atendente vai junto.
 */
export type CrowdRole = 'resident' | 'shopkeeper' | 'cook' | 'customer' | 'clerk' | 'worker'
  | 'officer' | 'citizen';

export interface CrowdRoleSpec {
  role: CrowdRole;
  /** Espécies de móvel que servem de base, na ordem de preferência. */
  anchors: string[];
  char: CharId;
  /** Uniforme: o oficial de plantão anda de farda, o resto é civil. */
  kind: NPCKind;
  /** Raio de caminhada em torno da base, em tiles. Curto = a pessoa trabalha no lugar. */
  roam: number;
  /** Velocidade de passeio, em tiles por segundo. */
  speed: number;
}

/** Sala de estar e quarto: dois moradores, um em cada metade da casa. */
const HOME: CrowdRoleSpec[] = [
  { role: 'resident', anchors: ['sofa', 'table'], char: 'a', kind: 'civ', roam: 1.05, speed: 0.5 },
  { role: 'resident', anchors: ['bed', 'desk'], char: 'b', kind: 'civ', roam: 0.85, speed: 0.45 },
];

/** Comércio: quem atende o caixa, quem faz a comida e quem está comprando. */
const SHOP: CrowdRoleSpec[] = [
  { role: 'shopkeeper', anchors: ['counter'], char: 'b', kind: 'civ', roam: 0.3, speed: 0.32 },
  { role: 'cook', anchors: ['grill'], char: 'c', kind: 'civ', roam: 0.25, speed: 0.3 },
  { role: 'customer', anchors: ['table', 'booth', 'stool'], char: 'a', kind: 'civ', roam: 1.05, speed: 0.55 },
  { role: 'customer', anchors: ['shelf', 'rack', 'crate'], char: 'c', kind: 'civ', roam: 1.15, speed: 0.5 },
];

/** Escritório: a recepção e um funcionário circulando. */
const OFFICE: CrowdRoleSpec[] = [
  { role: 'clerk', anchors: ['shelf', 'desk'], char: 'b', kind: 'civ', roam: 0.45, speed: 0.35 },
  { role: 'worker', anchors: ['desk', 'sofa', 'plant'], char: 'a', kind: 'civ', roam: 1.1, speed: 0.5 },
];

/**
 * Delegacia: o oficial de plantão no balcão, um segundo circulando entre as escrivanias
 * e o cidadão sentado à espera. É elenco de sala, não guarnição — quem persegue na rua é
 * o PoliceSystem, e ele não enxerga para dentro destas paredes.
 */
const PRECINCT: CrowdRoleSpec[] = [
  { role: 'officer', anchors: ['counter'], char: 'a', kind: 'cop', roam: 0.3, speed: 0.32 },
  { role: 'officer', anchors: ['desk'], char: 'b', kind: 'cop', roam: 0.95, speed: 0.45 },
  { role: 'citizen', anchors: ['sofa', 'table'], char: 'c', kind: 'civ', roam: 0.75, speed: 0.4 },
];

/**
 * Rodoviária: a bilheteira no balcão, um passageiro sentado esperando a linha e outro de pé
 * perto da catraca. É elenco de sala, não multidão — quem enche a plataforma lá fora é o
 * horário, não esta planta.
 */
const TERMINAL: CrowdRoleSpec[] = [
  { role: 'clerk', anchors: ['counter'], char: 'b', kind: 'civ', roam: 0.3, speed: 0.32 },
  { role: 'citizen', anchors: ['sofa'], char: 'a', kind: 'civ', roam: 0.8, speed: 0.42 },
  { role: 'citizen', anchors: ['plant', 'crate'], char: 'c', kind: 'civ', roam: 1.1, speed: 0.5 },
];

/**
 * Elenco de uma sala. A cadeia fica de fora: lá o elenco é de presos e guarda, e quem
 * o manda é o `JailSystem`. O resto é a planta quem decide — um papel cuja base não
 * existe no layout (o cozinheiro sem cozinha, o cliente sem mesa) não é contratado.
 */
export function crowdRolesFor(kind: InteriorKind): CrowdRoleSpec[] {
  return kind === 'home' ? HOME : kind === 'office' ? OFFICE : kind === 'shop' ? SHOP
    : kind === 'precinct' ? PRECINCT : kind === 'terminal' ? TERMINAL : [];
}
