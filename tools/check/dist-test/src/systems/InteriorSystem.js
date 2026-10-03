"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InteriorSystem = void 0;
const Map_1 = require("../world/Map");
const Player_1 = require("../entities/Player");
const shop_1 = require("../data/shop");
const GameConfig_1 = require("../game/GameConfig");
const jail_1 = require("../data/jail");
const IsoUtils_1 = require("../world/IsoUtils");
/** Nome de fachada de cada balcão com cardápio. */
const COUNTER_TITLE = { cafe: 'Café', pizza: 'Pizzaria', sorveteria: 'Sorveteria' };
function makeRoom(entrance) {
    const furniture = [];
    // A tile is ~1.5 m and the character sprite is 32 px (~1.7 m), so furniture is
    // sized against the player: a chair 0.5 tile, a bed 1.15 x 1.75, a 1.7 m shelf.
    const add = (id, kind, x, y, w, d, height, color) => {
        furniture.push({ id, kind, x, y, w, d, height, color });
    };
    if (entrance.kind === 'jail') {
        // A cadeia tem a própria planta (data/jail): cela, beliche, bucket e corredor de serviço.
        for (const piece of jail_1.JAIL_PIECES) {
            add(piece.id, piece.kind, piece.x, piece.y, piece.w, piece.d, piece.height, piece.color);
        }
    }
    else if (entrance.kind === 'precinct') {
        // Delegacia aberta: balcão de atendimento no fundo, duas escrivanias de escrivão,
        // arquivo de provas na parede e um banco para quem espera na sala.
        add('counter', 'counter', 3.6, 0.45, 2.4, 0.65, 20, '#4f5d6a');
        add('desk-a', 'desk', 0.6, 0.45, 1.3, 0.65, 15, '#7c8894');
        add('desk-b', 'desk', 2.05, 0.45, 1.3, 0.65, 15, '#7c8894');
        add('evidence', 'shelf', 0.35, 1.65, 0.45, 1.7, 34, '#6d7681');
        add('crate', 'crate', 6.15, 0.4, 0.7, 0.7, 17, '#6f7d4f');
        add('bench', 'sofa', 0.95, 3.5, 1.7, 0.7, 16, '#3f5566');
        add('table', 'table', 3.1, 2.5, 0.85, 0.85, 14, '#8a7250');
        add('plant', 'plant', 6.3, 4.05, 0.5, 0.5, 26, '#408752');
    }
    else if (entrance.kind === 'home') {
        add('shelf', 'shelf', 0.5, 0.4, 1.5, 0.4, 34, '#926440');
        add('desk', 'desk', 3.2, 0.45, 1.3, 0.6, 15, '#ae8354');
        add('chair', 'chair', 3.6, 1.3, 0.5, 0.5, 13, '#665340');
        add('bed', 'bed', 5.5, 0.45, 1.15, 1.75, 13, '#759fb9');
        add('sofa', 'sofa', 0.55, 2.3, 1.7, 0.7, 16, '#3d8791');
        add('table', 'table', 1.1, 3.4, 1.0, 0.6, 14, '#ba905f');
        add('plant', 'plant', 6.2, 3.9, 0.5, 0.5, 26, '#408752');
    }
    else if (entrance.counter === 'armaria') {
        // Armaria: armário de armas na parede do fundo, balcão à direita, caixas no chão.
        add('rack', 'rack', 0.5, 0.35, 2.7, 0.4, 40, '#4d5a67');
        add('counter', 'counter', 3.6, 0.45, 2.4, 0.65, 20, '#5c6b78');
        add('stool', 'stool', 6.1, 1.35, 0.5, 0.5, 13, '#3f4a55');
        add('ammo-shelf', 'shelf', 0.35, 1.6, 0.45, 1.7, 34, '#8c6748');
        add('crate', 'crate', 1.15, 3.1, 0.85, 0.85, 17, '#6f7d4f');
        add('crate-b', 'crate', 2.2, 3.5, 0.7, 0.7, 14, '#7d6a45');
        add('display', 'table', 4.7, 3.1, 1.1, 1.0, 15, '#8e7250');
        add('plant', 'plant', 6.3, 4.1, 0.5, 0.5, 26, '#408752');
    }
    else if (entrance.kind === 'shop') {
        // Restaurante: cozinha atrás do balcão e mesas para sentar.
        add('counter', 'counter', 3.6, 0.45, 2.4, 0.65, 20, '#608979');
        add('seat-a', 'chair', 0.75, 2.6, 0.55, 0.55, 13, '#8e5b43');
        add('table-a', 'table', 1.4, 2.55, 0.75, 0.75, 14, '#a8875a');
        add('table-b', 'table', 4.9, 2.9, 0.9, 0.9, 14, '#a8875a');
        add('seat-b', 'chair', 4.25, 2.95, 0.55, 0.55, 13, '#8e5b43');
        add('seat-c', 'chair', 5.9, 3.0, 0.55, 0.55, 13, '#8e5b43');
        if (entrance.counter === 'pizza') {
            add('oven', 'grill', 0.45, 0.4, 1.9, 0.6, 26, '#a5502f');
            add('box-stack', 'crate', 6.15, 0.4, 0.7, 0.7, 20, '#9a7b52');
            add('booth', 'booth', 0.55, 3.7, 1.6, 0.7, 22, '#7d4a3a');
        }
        else if (entrance.counter === 'sorveteria') {
            add('display', 'counter', 0.45, 0.4, 2.0, 0.6, 24, '#c9a0b8');
            add('sundae-bar', 'table', 2.9, 0.5, 1.4, 0.5, 15, '#b58a6a');
            add('stool-a', 'stool', 3.1, 1.25, 0.45, 0.45, 13, '#4a6076');
            add('stool-b', 'stool', 3.9, 1.25, 0.45, 0.45, 13, '#4a6076');
        }
        else {
            add('grill', 'grill', 0.5, 0.4, 1.5, 0.6, 24, '#5a6570');
            add('shelf', 'shelf', 2.3, 0.4, 1.2, 0.4, 34, '#8c6748');
            add('plant', 'plant', 6.4, 1.6, 0.5, 0.5, 26, '#408752');
        }
    }
    else {
        add('desk-a', 'desk', 0.6, 0.45, 1.3, 0.65, 15, '#997b5b');
        add('desk-b', 'desk', 2.4, 0.45, 1.3, 0.65, 15, '#997b5b');
        add('chair-a', 'chair', 1, 1.35, 0.5, 0.5, 13, '#44586b');
        add('chair-b', 'chair', 2.8, 1.35, 0.5, 0.5, 13, '#44586b');
        add('shelf', 'shelf', 4.6, 0.4, 1.6, 0.4, 34, '#8c6748');
        add('sofa', 'sofa', 5.6, 2.2, 1.0, 0.7, 16, '#64745e');
        add('plant', 'plant', 0.6, 3.6, 0.5, 0.5, 26, '#408752');
    }
    const jail = entrance.kind === 'jail';
    const W = jail ? jail_1.JAIL_W : 7;
    const H = jail ? jail_1.JAIL_H : 5;
    // As grades ficam fora da colisão estática: uma cela aberta precisa sumir com a
    // parede, e isso é o JailSystem quem manda, célula por célula.
    const colliders = furniture
        .filter((f) => f.kind !== 'bars')
        .map((f) => ({ x: f.x, y: f.y, width: f.w, height: f.d, type: 'PROP' }));
    colliders.push({ x: 0, y: 0, width: W, height: 0.35, type: 'BUILDING' }, { x: 0, y: 0, width: 0.35, height: H, type: 'BUILDING' }, { x: W - 0.35, y: 0, width: 0.35, height: H, type: 'BUILDING' }, { x: 0, y: H - 0.35, width: W, height: 0.35, type: 'BUILDING' });
    const data = {
        tilesW: W, tilesH: H, worldW: W, worldH: H,
        tiles: Array.from({ length: W * H }, () => ({ kind: 'concrete', key: 'tile_ground_concrete',
            biome: jail ? 'downtown' : 'residential' })),
        // Sala é uma casa de boneca: o chão interno é próprio e plano, a altura da rua
        // fica do lado de fora. O `h` do interior nunca entra na projeção da cidade.
        heights: new Float32Array(W * H),
        buildings: [], props: [], vehicles: [], npcSpawns: [],
        playerSpawn: jail ? { x: jail_1.JAIL_SPAWN.x, y: jail_1.JAIL_SPAWN.y } : { x: 3.5, y: 3.9 },
    };
    const shop = entrance.counter === 'armaria'
        ? { title: 'Armaria', items: shop_1.GUN_STORE_STOCK }
        : entrance.counter ? { title: COUNTER_TITLE[entrance.counter], items: shop_1.FOOD_MENUS[entrance.counter] } : null;
    const service = jail
        ? { x: jail_1.JAIL_PANEL.x, y: jail_1.JAIL_PANEL.y, label: 'Painel de celas', cost: 0, action: 'none' }
        : shop
            ? { x: 4.6, y: 1.5, label: `Balcão · ${shop.title}`, cost: 0, action: 'none' }
            : entrance.service === 'bail'
                ? { x: 4.6, y: 1.5, label: `Fiança · $${GameConfig_1.GAME_CONFIG.BAIL_PER_STAR} por estrela`, cost: GameConfig_1.GAME_CONFIG.BAIL_PER_STAR,
                    action: 'bail' }
                : entrance.service === 'rest'
                    ? { x: 5.6, y: 2.7, label: 'Descansar · $25', cost: 25, action: 'heal' }
                    : { x: 2, y: 3.3, label: 'Primeiros socorros · $40', cost: 40, action: 'heal' };
    return { id: entrance.id, label: entrance.label, kind: entrance.kind, entrance, map: new Map_1.Map(data, colliders), furniture,
        exit: jail ? { x: jail_1.JAIL_EXIT.x, y: jail_1.JAIL_EXIT.y } : { x: 3.5, y: 4.3 }, service, shop };
}
class InteriorSystem {
    constructor(map) {
        this.entrances = [];
        this.active = null;
        /**
         * O lugar da cidade onde o jogador está, do ponto de vista de quem ficou na rua.
         * Enquanto `active` existe, `player.x/y` são do plano da sala e não significam nada
         * no mapa — este é o ponto que a rua enxerga, que o save grava e para onde a porta
         * devolve. Null só quando não há sala aberta.
         */
        this.street = null;
        this.message = '';
        /**
         * Gancho da cadeia (injetado pelo GameState): a cela e o painel são interação de
         * dentro de uma sala, mas quem manda neles é o JailSystem. InteriorSystem não
         * importa JailSystem — o laço é só função, para os dois sistemas continuarem independentes.
         */
        this.delegate = null;
        this.messageLeft = 0;
        this.transitionLock = 0;
        this.rooms = new globalThis.Map();
        const clear = (x, y) => {
            const tile = map.tileKindAt(x, y);
            return tile !== null && tile !== 'water' && tile !== 'road' && !map.queryNearby(x, y, 0.5).some((c) => x > c.x - 0.2 && x < c.x + c.width + 0.2 && y > c.y - 0.2 && y < c.y + c.height + 0.2);
        };
        // A cadeia fica na esquadra mais isolada da cidade — longe do centro, no extremo
        // do mapa — para o presídio não ser uma salinha no meio dos comércios.
        const stations = map.landmarksOf('police');
        const centerX = map.data.worldW / 2, centerY = map.data.worldH / 2;
        let prison = null;
        let isolation = -1;
        for (const station of stations) {
            const distance = Math.hypot(station.front.x - centerX, station.front.y - centerY);
            if (distance > isolation) {
                isolation = distance;
                prison = station;
            }
        }
        const station = prison ? map.data.buildings.findIndex((b) => b.key.startsWith('bld_policestation')
            && Math.abs(b.x - b.footprintW / 2 - prison.x) < 1e-6 && Math.abs(b.y - b.footprintW / 2 - prison.y) < 1e-6) : -1;
        if (prison && station >= 0 && clear(prison.front.x, prison.front.y)) {
            this.entrances.push({ id: station, x: prison.front.x, y: prison.front.y, kind: 'jail',
                label: 'Cadeia', service: 'cells', counter: null, facing: Math.PI / 2 });
        }
        const buildings = [...map.data.buildings.entries()].sort(([, a], [, b]) => Number(b.key.includes('gunshop')) - Number(a.key.includes('gunshop')));
        for (const [id, building] of buildings) {
            const { key, tag, footprintW: size } = building;
            const home = /^house_(small|medium)$/.test(tag) || tag === 'apartments';
            const shop = tag === 'shop' && /gunshop|cafe|pizza|icecream/.test(key);
            const office = /^office_/.test(tag);
            if ((!home && !shop && !office) || !map.sidewalkNodes.length)
                continue;
            const tx = Math.floor(building.x - size / 2), ty = Math.floor(building.y - size / 2);
            const biome = map.data.tiles[ty * map.data.tilesW + tx]?.biome;
            // Casa tem porta em todo distrito que tenha casa, inclusive o sítio na mata,
            // na praia e no deserto; só o parque não mora dentro.
            if (home ? biome === undefined || biome === 'park'
                : !['downtown', 'commercial', 'market'].includes(biome))
                continue;
            const faceB = key.endsWith('_b');
            const offset = shop ? (faceB ? 0.3 : 0.75) : tag === 'house_medium' ? (faceB ? 0.25 : 0.7) : 0.5;
            const x = faceB ? building.x + 0.24 : building.x - size * offset;
            const y = faceB ? building.y - size * offset : building.y + 0.24;
            if (!clear(x, y) || this.entrances.some((e) => Math.hypot(e.x - x, e.y - y) < 8))
                continue;
            const accessible = map.sidewalkNodes.some((node) => {
                const dx = node.x - x, dy = node.y - y, distance = Math.hypot(dx, dy);
                if (distance > 2.5 || (faceB ? dx : dy) < -0.1)
                    return false;
                const steps = Math.max(1, Math.ceil(distance / 0.15));
                for (let i = 1; i <= steps; i++)
                    if (!clear(x + dx * i / steps, y + dy * i / steps))
                        return false;
                return true;
            });
            if (!accessible)
                continue;
            const kind = home ? 'home' : shop ? 'shop' : 'office';
            const service = home ? 'rest' : office ? 'firstAid' : key.includes('gunshop') ? 'ammo' : 'food';
            const counter = !shop ? null
                : key.includes('gunshop') ? 'armaria' : key.includes('pizza') ? 'pizza'
                    : key.includes('icecream') ? 'sorveteria' : 'cafe';
            const label = home ? (tag === 'apartments' ? 'Apartamento' : 'Residência') : office ? 'Escritório'
                : key.includes('gunshop') ? 'Armaria' : key.includes('cafe') ? 'Café' : key.includes('pizza') ? 'Pizzaria' : 'Sorveteria';
            this.entrances.push({ id, x, y, kind, label, service, counter, facing: faceB ? 0 : Math.PI / 2 });
        }
        // Toda esquadra tem porta de delegacia, aberta a qualquer hora e sem depender de ser
        // preso para descobrir que ela existia: quem quer se entregar ou pagar fiança entra pela
        // calçada. A esquadra presídio fica de fora — ali o passeio já é a porta da cadeia.
        for (const station of stations) {
            if (station === prison)
                continue;
            const id = map.data.buildings.findIndex((b) => b.key.startsWith('bld_policestation')
                && Math.abs(b.x - b.footprintW / 2 - station.x) < 1e-6 && Math.abs(b.y - b.footprintW / 2 - station.y) < 1e-6);
            if (id < 0)
                continue;
            const spot = map.sidewalkNodes
                .filter((node) => Math.hypot(node.x - station.front.x, node.y - station.front.y) < 3)
                .sort((a, b) => Math.hypot(a.x - station.front.x, a.y - station.front.y)
                - Math.hypot(b.x - station.front.x, b.y - station.front.y))
                .find((node) => clear(node.x, node.y)
                && this.entrances.every((e) => Math.hypot(e.x - node.x, e.y - node.y) >= 2.5));
            if (!spot)
                continue;
            this.entrances.push({ id, x: spot.x, y: spot.y, kind: 'precinct', label: 'Delegacia',
                service: 'bail', counter: null, facing: Math.atan2(spot.y - station.y, spot.x - station.x) });
        }
    }
    update(dt) {
        this.transitionLock = Math.max(0, this.transitionLock - dt);
        this.messageLeft = Math.max(0, this.messageLeft - dt);
        if (!this.messageLeft)
            this.message = '';
    }
    nearest(player) {
        if ((0, Player_1.isAboard)(player) || player.swimming || player.health <= 0)
            return null;
        let found = null;
        let distance = 0.85;
        for (const entrance of this.entrances) {
            const dx = player.x - entrance.x, dy = player.y - entrance.y;
            if (dx * Math.cos(entrance.facing) + dy * Math.sin(entrance.facing) < -0.1)
                continue;
            const d = Math.hypot(dx, dy);
            if (d < distance) {
                found = entrance;
                distance = d;
            }
        }
        return found;
    }
    /** Recado curto no lugar da dica da sala; é assim que a cadeia avisa o que falta. */
    say(text, seconds = 2.4) {
        this.message = text;
        this.messageLeft = seconds;
    }
    prompt(player) {
        if (this.message)
            return this.message;
        if (!this.active)
            return this.nearest(player)?.label ?? null;
        // Cela e painel vêm antes da porta: quem está na grade não quer sair, quer abrir.
        if (this.active.kind === 'jail' && this.delegate) {
            const jail = this.delegate.prompt(player);
            if (jail)
                return jail;
        }
        if (Math.hypot(player.x - this.active.exit.x, player.y - this.active.exit.y) < 1.2)
            return 'Sair para a rua';
        if (Math.hypot(player.x - this.active.service.x, player.y - this.active.service.y) < 1.25) {
            return this.serviceLabel(this.active, player);
        }
        return null;
    }
    /** O balcão da delegacia cobra por estrela ainda no registro, então o preço é do momento. */
    serviceLabel(room, player) {
        if (room.service.action !== 'bail')
            return room.service.label;
        const stars = Math.ceil(player.wantedLevel);
        return stars > 0 ? `Pagar fiança · $${room.service.cost * stars}` : 'Balcão de atendimento';
    }
    interact(ctx) {
        const player = ctx.player;
        if (this.transitionLock > 0 || (0, Player_1.isAboard)(player) || player.swimming || player.health <= 0)
            return false;
        if (!this.active) {
            const entrance = this.nearest(player);
            if (!entrance)
                return false;
            let room = this.rooms.get(entrance.id);
            if (!room) {
                room = makeRoom(entrance);
                this.rooms.set(entrance.id, room);
            }
            // Entra pelo pé da porta: é de lá que a rua continua vendo o jogador, e é para lá
            // que a saída devolve — não para o centro do lote ao lado.
            this.street = { x: player.x, y: player.y, facing: player.facingAngle };
            this.active = room;
            this.place(player, room.map.data.playerSpawn);
            ctx.onTransition();
            return true;
        }
        const room = this.active;
        if (room.kind === 'jail' && this.delegate?.interact(ctx))
            return true;
        if (Math.hypot(player.x - room.exit.x, player.y - room.exit.y) < 1.2) {
            this.leave(player);
            ctx.onTransition();
            return true;
        }
        if (Math.hypot(player.x - room.service.x, player.y - room.service.y) >= 1.25)
            return false;
        if (room.shop) {
            // Loja de verdade: o balcão abre o cardápio em vez de vender um item só.
            ctx.onOpenShop();
            this.transitionLock = 0.4;
            return true;
        }
        if (room.service.action === 'bail') {
            // Fiança: o registro é do WantedSystem, a sala só cobra e chama o balcão.
            const stars = Math.ceil(player.wantedLevel);
            const cost = room.service.cost * stars;
            if (stars <= 0)
                this.message = 'Você não está procurado';
            else if (player.money < cost)
                this.message = 'Dinheiro insuficiente';
            else {
                player.money -= cost;
                ctx.clearRecord();
                this.message = 'Fiança paga';
                ctx.onUse();
            }
            this.messageLeft = 2.4;
            this.transitionLock = 0.4;
            return true;
        }
        if (room.service.action !== 'heal')
            return false;
        if (player.money < room.service.cost)
            this.message = 'Dinheiro insuficiente';
        else if (player.health >= 100)
            this.message = 'Vida completa';
        else {
            player.money -= room.service.cost;
            ctx.heal();
            this.message = 'Vida recuperada';
            ctx.onUse();
        }
        this.messageLeft = 2;
        this.transitionLock = 0.4;
        return true;
    }
    /** Compra no balcão aberto. Devolve false quando o item não pode ser vendido agora. */
    buy(itemId, ctx) {
        const room = this.active;
        const item = room?.shop?.items.find((stock) => stock.id === itemId);
        if (!room || !item)
            return false;
        const player = ctx.player;
        if (player.money < item.price)
            this.message = 'Dinheiro insuficiente';
        else if (item.kind === 'gun' && !ctx.grantGun(item.gun))
            this.message = 'Você já tem essa arma';
        else if (item.kind === 'ammo' && !ctx.refillOwned())
            this.message = 'Nenhuma arma para abastecer';
        else if (item.kind === 'meal' && player.health >= 100 && player.stamina >= 1)
            this.message = 'Sem fome';
        else {
            player.money -= item.price;
            if (item.kind === 'meal')
                ctx.feed(item.health ?? 0, item.stamina ?? 0);
            this.message = item.kind === 'gun' ? `${item.label} comprada`
                : item.kind === 'ammo' ? 'Munição reabastecida' : 'Bom apetite';
            ctx.onUse();
            this.messageLeft = 2.4;
            return true;
        }
        this.messageLeft = 2;
        return false;
    }
    /** Porta da cadeia, quando o mapa tem delegacia. É a única sala que o jogo abre sozinho. */
    get jailEntrance() {
        return this.entrances.find((entrance) => entrance.kind === 'jail') ?? null;
    }
    /** Abre uma sala pelo endereço, sem o jogador pedir: a prisão leva o preso para dentro. */
    open(entrance, player) {
        let room = this.rooms.get(entrance.id);
        if (!room) {
            room = makeRoom(entrance);
            this.rooms.set(entrance.id, room);
        }
        // Quem é algemado na rua não volta para o beco onde caiu: sai pela porta de quem o prendeu.
        this.street = { x: entrance.x, y: entrance.y, facing: entrance.facing };
        this.active = room;
        this.place(player, room.map.data.playerSpawn);
        return room;
    }
    leave(player) {
        if (!this.active)
            return;
        const back = this.street ?? this.active.entrance;
        this.active = null;
        this.street = null;
        this.place(player, back);
        player.facingAngle = back.facing;
        player.direction = (0, IsoUtils_1.angleToWorldDir)(player.facingAngle);
    }
    place(player, point) {
        player.x = point.x;
        player.y = point.y;
        player.vx = player.vy = player.speed = 0;
        player.swimming = false;
        player.state = 'idle';
        player.anim = 'idle';
        player.frame = player.animTimer = player.attackTimer = 0;
        this.transitionLock = 0.5;
        this.message = '';
    }
}
exports.InteriorSystem = InteriorSystem;
