"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovementSystem = exports.MAX_VAULT_FENCE_THICKNESS = exports.FENCE_CLEARANCE_PX = void 0;
exports.isLowFence = isLowFence;
exports.solidVehicleColliders = solidVehicleColliders;
exports.solidBusColliders = solidBusColliders;
exports.movePlayerGround = movePlayerGround;
const GameConfig_1 = require("../game/GameConfig");
const InputState_1 = require("../game/InputState");
const IsoUtils_1 = require("../world/IsoUtils");
const CollisionSystem_1 = require("./CollisionSystem");
const CrouchSystem_1 = require("./CrouchSystem");
const TerrainSystem_1 = require("./TerrainSystem");
const Frontier_1 = require("../world/Frontier");
exports.FENCE_CLEARANCE_PX = 12;
exports.MAX_VAULT_FENCE_THICKNESS = 0.4;
/**
 * O ar de quando ninguém informou a coluna: teto de oito tiles, nada de vento, subida cheia.
 * É o default porque é a verdade de quem está na rua — e porque um sistema de clima não pode
 * mudar o voo raso de um check que não falou com ele.
 */
const AR_DE_SEMPRE = Object.freeze({
    cota: 0, chao: 0, teto: GameConfig_1.GAME_CONFIG.HELI_CEILING_ELEVATION,
    base: GameConfig_1.GAME_CONFIG.NUVEM_BASE_ALTA, topo: GameConfig_1.GAME_CONFIG.NUVEM_BASE_ALTA, cobertura: 0,
    dentro: 0, bruma: 0, fechamento: 0, acima: 0, visivel: 1, rarefeito: 0, cidade: 1,
    ventoX: 0, ventoY: 0,
});
function isLowFence(c) {
    return c.type === 'FENCE' && Math.min(c.width, c.height) <= exports.MAX_VAULT_FENCE_THICKNESS;
}
/** Conservative vehicle footprints, also used to certify a vault's entire route. */
function solidVehicleColliders(vehicles) {
    return vehicles.filter((v) => v.state !== 'destroyed' && !(v.altitude > 0.5)).map(CollisionSystem_1.vehicleGroundCollider);
}
/**
 * A lataria dos ônibus do horário na mesma lista dos carros. Só os vivos: o corpo que não está
 * no alcance da câmera não tem posição calculada naquele instante, e deixá-lo na lista seria uma
 * parede invisível exatamente onde o jogador não vê ônibus nenhum.
 */
function solidBusColliders(bodies) {
    return bodies.filter((b) => b.live).map(CollisionSystem_1.streetBodyCollider);
}
/** Shared by ordinary locomotion and JumpSystem's certified vault, not vehicles. */
function movePlayerGround(player, map, collision, dx, dy, vehicles = [], buses = []) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy))
        return;
    const radius = GameConfig_1.GAME_CONFIG.PLAYER_RADIUS;
    // Thin fences/walls must not be tunneled through during a long simulation tick.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (radius * 0.5)));
    const sx = dx / steps;
    const sy = dy / steps;
    const cars = solidVehicleColliders(vehicles).concat(solidBusColliders(buses));
    const clearFence = player.jumpTimer > 0 && player.jumpEnd !== null &&
        player.jumpHeight >= exports.FENCE_CLEARANCE_PX;
    const resolve = () => {
        const nearby = map.queryNearby(player.x, player.y, radius + 0.2);
        const obstacles = clearFence ? nearby.filter((c) => !isLowFence(c)) : nearby;
        const circle = { x: player.x, y: player.y, radius };
        collision.resolveCircle(circle, obstacles.concat(cars));
        // A cidade tem parede de colisor; o que acaba o mundo não é a borda da grade, é a mata.
        // Dentro do mapa isto é o mesmo clamp de antes com um `Math.min` mais largo, e o tronco
        // nem é perguntado — quem anda na rua não paga pela floresta que não está lá.
        (0, Frontier_1.seguraNaFronteira)(circle, map.worldW, map.worldH, map);
        player.x = circle.x;
        player.y = circle.y;
    };
    for (let step = 0; step < steps; step++) {
        const prevX = player.x;
        const prevY = player.y;
        if (Math.abs(sx) > 1e-8) {
            player.x += sx;
            resolve();
        }
        if (Math.abs(sy) > 1e-8) {
            player.y += sy;
            resolve();
        }
        // O talude julga por último: nem o passo nem o empurrão de um carro abrem caminho
        // morro acima. No ar não há julgamento — é para isso que serve o pulo.
        if (player.jumpTimer <= 0)
            TerrainSystem_1.terrain.blockWalk(map, player, prevX, prevY);
    }
}
const TWO_PI = Math.PI * 2;
function angleDiff(from, to) {
    let d = to - from;
    while (d <= -Math.PI)
        d += TWO_PI;
    while (d > Math.PI)
        d -= TWO_PI;
    return d;
}
class MovementSystem {
    constructor(collision, getVehicles = () => [], 
    /** Os ônibus do horário: lataria na rua, e quem anda a pé bate nela. */
    getBuses = () => []) {
        this.collision = collision;
        this.getVehicles = getVehicles;
        this.getBuses = getBuses;
    }
    /** `flooded` = a água de um tsunami cobrindo o chão: ali também se nada, não se caminha. */
    updatePlayer(player, map, dt, runAllowed, flooded = false) {
        if (player.currentVehicleId !== null || player.health <= 0 ||
            player.state === 'driving' || player.state === 'enteringVehicle' || player.state === 'dead') {
            player.vx = 0;
            player.vy = 0;
            return;
        }
        if (!Number.isFinite(dt) || dt <= 0)
            return;
        // Only a guided vault owns horizontal motion. Ordinary jumps retain controls
        // and solid fences, so they cannot drift into an uncertified landing.
        if (player.jumpTimer > 0 && player.jumpEnd !== null) {
            player.vx = 0;
            player.vy = 0;
            player.speed = 0;
            return;
        }
        const { dx, dy, magnitude } = InputState_1.inputState;
        const runHeld = !player.crouching && (runAllowed === undefined ? InputState_1.inputState.runHeld : runAllowed);
        const dead = GameConfig_1.GAME_CONFIG.JOYSTICK_DEADZONE;
        const mag = magnitude;
        const inWater = flooded || map.isWaterWorld(player.x, player.y);
        let desiredVx = 0;
        let desiredVy = 0;
        let moving = false;
        let targetAngle = player.facingAngle;
        if (mag > dead) {
            const nx = dx / mag;
            const ny = dy / mag;
            const t = Math.min(1, (mag - dead) / (1 - dead));
            const curve = t * t * (3 - 2 * t);
            // Inverse of (worldX-worldY)*64, (worldX+worldY)*32.
            const { x: wx, y: wy } = (0, IsoUtils_1.screenToWorld)(nx, ny);
            const wlen = Math.hypot(wx, wy) || 1;
            const flat = inWater
                ? GameConfig_1.GAME_CONFIG.PLAYER_SWIM_SPEED
                : player.crouching ? CrouchSystem_1.CROUCH_SPEED
                    : runHeld ? GameConfig_1.GAME_CONFIG.PLAYER_RUN_SPEED : GameConfig_1.GAME_CONFIG.PLAYER_WALK_SPEED;
            // Na ladeira o passo encurta; na água não há ladeira.
            const maxSpeed = inWater ? flat : flat * TerrainSystem_1.terrain.speedFactor(map, player.x, player.y, wx / wlen, wy / wlen);
            desiredVx = (wx / wlen) * maxSpeed * curve;
            desiredVy = (wy / wlen) * maxSpeed * curve;
            moving = true;
            // ângulo alvo suave (sem snap)
            targetAngle = Math.atan2(wy, wx);
            player.direction = (0, IsoUtils_1.angleToWorldDir)(targetAngle);
            player.walkDir = player.direction;
        }
        // interpola facingAngle suavemente
        const turnSpeed = GameConfig_1.GAME_CONFIG.PLAYER_TURN_SPEED;
        const maxStep = turnSpeed * dt;
        const diff = angleDiff(player.facingAngle, targetAngle);
        if (Math.abs(diff) > maxStep) {
            player.facingAngle += diff > 0 ? maxStep : -maxStep;
        }
        else {
            player.facingAngle = targetAngle;
        }
        player.facingAngle = ((player.facingAngle % TWO_PI) + TWO_PI) % TWO_PI;
        if (moving) {
            const k = Math.min(1, GameConfig_1.GAME_CONFIG.PLAYER_ACCEL * dt);
            player.vx += (desiredVx - player.vx) * k;
            player.vy += (desiredVy - player.vy) * k;
        }
        else {
            const damp = Math.exp(-GameConfig_1.GAME_CONFIG.PLAYER_FRICTION * dt);
            player.vx *= damp;
            player.vy *= damp;
            if (Math.hypot(player.vx, player.vy) < 0.08) {
                player.vx = 0;
                player.vy = 0;
            }
        }
        // Folding out of a sprint must not retain running speed, even on a tiny tick.
        const speed = Math.hypot(player.vx, player.vy);
        if (player.crouching && !inWater && speed > CrouchSystem_1.CROUCH_SPEED) {
            player.vx *= CrouchSystem_1.CROUCH_SPEED / speed;
            player.vy *= CrouchSystem_1.CROUCH_SPEED / speed;
        }
        player.speed = Math.hypot(player.vx, player.vy);
        if (player.speed > 0.12 && !(mag > dead)) {
            targetAngle = Math.atan2(player.vy, player.vx);
            const diff2 = angleDiff(player.facingAngle, targetAngle);
            if (Math.abs(diff2) > maxStep) {
                player.facingAngle += diff2 > 0 ? maxStep : -maxStep;
            }
            else {
                player.facingAngle = targetAngle;
            }
        }
        movePlayerGround(player, map, this.collision, player.vx * dt, player.vy * dt, this.getVehicles(), this.getBuses());
        player.swimming = flooded || map.isWaterWorld(player.x, player.y);
        if (player.swimming) {
            player.anim = 'swim';
            player.state = player.speed > 0.08 ? 'walking' : 'idle';
        }
        else if (player.speed > 0.12) {
            player.anim = 'walk';
            player.state = player.speed > GameConfig_1.GAME_CONFIG.PLAYER_WALK_SPEED * 1.12 ? 'running' : 'walking';
        }
        else {
            player.anim = 'idle';
            player.state = 'idle';
            player.frame = 0;
            player.animTimer = 0;
        }
    }
    updateVehicle(vehicle, map, dt, ceu = AR_DE_SEMPRE) {
        if (vehicle.def.type === 'helicopter') {
            this.updateHelicopter(vehicle, map, dt, ceu);
            return;
        }
        const { vehicleAccel, vehicleBrake, vehicleLeft, vehicleRight } = InputState_1.inputState;
        const vdir = IsoUtils_1.DIR_VECTORS[vehicle.dir];
        // Subida corta o topo, descida alonga: é o peso da estrada de morro sem física nova.
        const maxSpeed = GameConfig_1.GAME_CONFIG.VEHICLE_MAX_SPEED * TerrainSystem_1.terrain.speedFactor(map, vehicle.x, vehicle.y, vdir.wx, vdir.wy);
        const reverseMax = maxSpeed * GameConfig_1.GAME_CONFIG.VEHICLE_REVERSE_RATIO;
        if (vehicleAccel && !vehicleBrake) {
            if (vehicle.speed < 0) {
                vehicle.speed = Math.min(0, vehicle.speed + GameConfig_1.GAME_CONFIG.VEHICLE_BRAKE * 1.6 * dt);
            }
            else {
                vehicle.speed = Math.min(maxSpeed, vehicle.speed + GameConfig_1.GAME_CONFIG.VEHICLE_ACCEL * dt);
            }
        }
        else if (vehicleBrake) {
            if (vehicle.speed > 0.02) {
                vehicle.speed = Math.max(0, vehicle.speed - GameConfig_1.GAME_CONFIG.VEHICLE_BRAKE * dt);
            }
            else {
                vehicle.speed = Math.max(-reverseMax, vehicle.speed - GameConfig_1.GAME_CONFIG.VEHICLE_REVERSE_ACCEL * dt);
            }
        }
        else {
            if (vehicle.speed > 0) {
                vehicle.speed = Math.max(0, vehicle.speed - GameConfig_1.GAME_CONFIG.VEHICLE_COAST * dt);
            }
            else if (vehicle.speed < 0) {
                vehicle.speed = Math.min(0, vehicle.speed + GameConfig_1.GAME_CONFIG.VEHICLE_COAST * dt);
            }
            if (Math.abs(vehicle.speed) < GameConfig_1.GAME_CONFIG.VEHICLE_STOP_EPS)
                vehicle.speed = 0;
        }
        // Só troca de faixa iso (90°) com o carro já andando — nunca gira parado
        const movingAbs = Math.abs(vehicle.speed);
        const wantTurn = (vehicleLeft && !vehicleRight) || (vehicleRight && !vehicleLeft);
        if (wantTurn && movingAbs >= GameConfig_1.GAME_CONFIG.VEHICLE_TURN_MIN_SPEED) {
            const reverse = vehicle.speed < 0;
            const turn = () => {
                if (vehicleLeft)
                    vehicle.dir = reverse ? TURN_CW[vehicle.dir] : TURN_CCW[vehicle.dir];
                else
                    vehicle.dir = reverse ? TURN_CCW[vehicle.dir] : TURN_CW[vehicle.dir];
            };
            if (vehicle.turnTimer <= 0) {
                turn();
                vehicle.turnTimer = 0.001;
            }
            else {
                vehicle.turnTimer += dt;
                if (vehicle.turnTimer >= GameConfig_1.GAME_CONFIG.VEHICLE_TURN_STEP_S) {
                    vehicle.turnTimer = 0.001;
                    turn();
                }
            }
        }
        else {
            vehicle.turnTimer = 0;
        }
        vehicle.facingAngle = (0, IsoUtils_1.dirToAngle)(vehicle.dir);
        // Relê a direção: o volante pode ter girado o carro neste mesmo tick.
        const step = IsoUtils_1.DIR_VECTORS[vehicle.dir];
        const vx = step.wx * vehicle.speed;
        const vy = step.wy * vehicle.speed;
        const radius = Math.max(GameConfig_1.GAME_CONFIG.VEHICLE_RADIUS, Math.min(vehicle.def.footprintW, vehicle.def.footprintH) * 0.28);
        const ox = vehicle.x;
        const oy = vehicle.y;
        this.slideMove(vehicle, map, vx, vy, dt, radius);
        if (map.isWaterWorld(vehicle.x, vehicle.y)) {
            vehicle.x = ox;
            vehicle.y = oy;
            vehicle.speed = 0;
        }
    }
    updateHelicopter(vehicle, map, dt, ceu) {
        const { heliUp, heliDown, dx, dy, magnitude } = InputState_1.inputState;
        const dead = GameConfig_1.GAME_CONFIG.JOYSTICK_DEADZONE;
        // Voo é por COTA (tiles acima do nível 0 do mundo), nunca por folga do solo: o chão
        // muda sob o nariz a cada metro andado e quem segura o manche segura a máquina no
        // céu. Sem isso o helicóptero pousava em pleno ar sobre um platô e atravessava a
        // montanha raspando a pedra.
        //
        // Duas leituras do mesmo chão, dois papéis. A cota que desenha a máquina e que a
        // impede de afundar é a superfície da malha (`heightSmoothAt`) — pousar na encosta é
        // pousar na rampa que está na tela. Já o alvo de levitação busca o platô ONDE a
        // máquina está (`heightAt`, a cota das regras): se ele lesse a face misturada à frente,
        // o próprio alvo subiria conforme o nariz encosta na montanha, e o rotor içaria o
        // helicóptero pelo talude sem ninguém tocar no pé de cabra. Muro é muro.
        const chao = map.heightSmoothAt(vehicle.x, vehicle.y);
        const levitacao = map.heightAt(vehicle.x, vehicle.y) + GameConfig_1.GAME_CONFIG.HELI_CRUISE_ALTITUDE;
        // Lá em cima o rotor empurra a mesma pá de um ar que pesa menos. É por isso que o teto do voo
        // não é uma parede no número: a subida vai murchando até a máquina parar sozinha, e o piloto
        // sente o manche perder resposta em vez de bater num clamp. Sem coluna informada, `rarefeito`
        // é zero e a taxa é a de sempre.
        const iça = GameConfig_1.GAME_CONFIG.HELI_CLIMB_RATE * (1 - GameConfig_1.GAME_CONFIG.AR_PERDE_SUBIDA * ceu.rarefeito);
        let alvo = vehicle.elevation;
        if (vehicle.motorDead) {
            // Motor morto: o manche não iça nada, e nem o comando de descer muda o resultado — a
            // máquina já está descendo sozinha, mais rápido do que qualquer mão faria. O que sobra ao
            // piloto é o nariz: a frente continua valendo, e é ela que transforma a queda em pouso.
            // O número é da física de voo (ficou ao lado do `HELI_SINK_RATE`), a decisão de matar o
            // motor é da `FrontierFallSystem`.
            alvo -= GameConfig_1.GAME_CONFIG.HELI_FALL_RATE * dt;
        }
        else if (heliUp)
            alvo += iça * dt;
        else if (heliDown)
            alvo -= GameConfig_1.GAME_CONFIG.HELI_SINK_RATE * dt;
        // Só o manche, sem cabra: ele busca a altura de levitação e para ali. É o lift-off de
        // quem quer atravessar a cidade por cima, e sobe na taxa do comando — um voo que salta
        // 140px num frame não é decolagem, é teletransporte.
        else if (magnitude > dead && vehicle.elevation < levitacao) {
            alvo = Math.min(levitacao, vehicle.elevation + iça * dt);
        }
        vehicle.elevation = Math.min(ceu.teto, Math.max(chao, alvo));
        let vx = 0;
        let vy = 0;
        if (magnitude > dead) {
            const nx = dx / magnitude;
            const ny = dy / magnitude;
            const t = Math.min(1, (magnitude - dead) / (1 - dead));
            const curve = t * t * (3 - 2 * t);
            const { x: wx, y: wy } = (0, IsoUtils_1.screenToWorld)(nx, ny);
            const wlen = Math.hypot(wx, wy) || 1;
            const spd = GameConfig_1.GAME_CONFIG.HELI_MAX_SPEED * curve
                * (1 - GameConfig_1.GAME_CONFIG.AR_PERDE_CURSO * ceu.rarefeito);
            vx = (wx / wlen) * spd;
            vy = (wy / wlen) * spd;
            vehicle.dir = (0, IsoUtils_1.angleToWorldDir)(Math.atan2(wy, wx));
            vehicle.speed = spd;
        }
        else {
            vehicle.speed = Math.max(0, vehicle.speed - GameConfig_1.GAME_CONFIG.VEHICLE_COAST * dt);
            const vdir = IsoUtils_1.DIR_VECTORS[vehicle.dir];
            vx = vdir.wx * vehicle.speed;
            vy = vdir.wy * vehicle.speed;
        }
        const prevX = vehicle.x;
        const prevY = vehicle.y;
        vehicle.x += vx * dt;
        vehicle.y += vy * dt;
        vehicle.facingAngle = (0, IsoUtils_1.dirToAngle)(vehicle.dir);
        // O vento da frente empurra o casco, e empurra mais quanto mais alto: no meio da rua o prédio
        // barra o ar, lá em cima não há nada que o barra. É isso que faz alcançar um ponto do mapa
        // sendo pilotagem e não apontar o nariz — e dentro da nuvem, sem chão na tela, é a única pista
        // que sobra de para onde a máquina está indo. No solo o atrito segura: `noAr` só libera a
        // deriva depois que a roda sai do chão.
        const noAr = Math.max(0, Math.min(1, vehicle.altitude / 1.2));
        if (noAr > 0) {
            vehicle.x += ceu.ventoX * dt * noAr;
            vehicle.y += ceu.ventoY * dt * noAr;
        }
        const r = 0.4;
        // Quem está no ar sobrevoa a mata: o limite do helicóptero é o mesmo alcance, sem tronco no
        // caminho. Não é um licença para ir aonde quiser — é o que faz a fronteira aérea existir: se
        // o ar parasse na borda como o chão para no tronco, não haveria queda, só uma parede. O que
        // derruba a máquina é o motor, e quem o mata é a `FrontierFallSystem`.
        vehicle.x = (0, Frontier_1.limiteJogável)(vehicle.x, map.worldW, r);
        vehicle.y = (0, Frontier_1.limiteJogável)(vehicle.y, map.worldH, r);
        if (TerrainSystem_1.terrain.blockFlight(map, vehicle, prevX, prevY, vehicle.elevation))
            vehicle.speed = 0;
        // A folga é o que sobra entre a cota e o chão de agora. Saiu do platô para a
        // planície, a cota continua e o buraco embaixo dele é que cresce.
        const novoChao = map.heightSmoothAt(vehicle.x, vehicle.y);
        if (vehicle.elevation < novoChao)
            vehicle.elevation = novoChao;
        vehicle.altitude = vehicle.elevation - novoChao;
    }
    /**
     * Aeronave sem piloto no comando desce até o chão DEBAIXO DELA, não até o nível zero
     * do mundo: um helicóptero estacionado na crista tem de pousar na crista.
     */
    settleAirborne(vehicle, map, dt) {
        if (vehicle.def.type !== 'helicopter')
            return;
        const chao = map.heightSmoothAt(vehicle.x, vehicle.y);
        // Abandonada com o motor morto, a máquina continua caindo em vez de descer civilizadamente:
        // largar o helicóptero no ar da fronteira não apagou o que já estava acontecendo com ele.
        const taxa = vehicle.motorDead ? GameConfig_1.GAME_CONFIG.HELI_FALL_RATE : GameConfig_1.GAME_CONFIG.HELI_SINK_RATE;
        vehicle.elevation = Math.max(chao, vehicle.elevation - taxa * dt);
        vehicle.altitude = vehicle.elevation - chao;
    }
    slideMove(e, map, vx, vy, dt, radius) {
        const stepX = vx * dt;
        const stepY = vy * dt;
        const queryR = radius + Math.hypot(stepX, stepY) + 1.4;
        const prevX = e.x;
        const prevY = e.y;
        if (Math.abs(stepX) > 1e-8) {
            e.x += stepX;
            const nearby = map.queryNearby(e.x, e.y, queryR);
            const c = { x: e.x, y: e.y, radius };
            this.collision.resolveCircle(c, nearby);
            e.x = c.x;
            e.y = c.y;
        }
        if (Math.abs(stepY) > 1e-8) {
            e.y += stepY;
            const nearby = map.queryNearby(e.x, e.y, queryR);
            const c = { x: e.x, y: e.y, radius };
            this.collision.resolveCircle(c, nearby);
            e.x = c.x;
            e.y = c.y;
        }
        // Um talude no fim da rua para o carro como uma parede: o asfalto é suavizado,
        // então barrar aqui só pega quem tentou atalhar pelo mato.
        TerrainSystem_1.terrain.blockDrive(map, e, prevX, prevY);
        // O mato é o fim do mapa para o carro também: quem atalha pela floresta é desviado por
        // tronco, não por um limite que para o carro no meio de uma clareira vazia.
        const corpo = { x: e.x, y: e.y, radius };
        (0, Frontier_1.seguraNaFronteira)(corpo, map.worldW, map.worldH, map);
        e.x = corpo.x;
        e.y = corpo.y;
    }
}
exports.MovementSystem = MovementSystem;
const TURN_CW = { SE: 'SW', SW: 'NW', NW: 'NE', NE: 'SE' };
const TURN_CCW = { SE: 'NE', NE: 'NW', NW: 'SW', SW: 'SE' };
