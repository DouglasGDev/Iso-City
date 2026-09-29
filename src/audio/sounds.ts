/**
 * Registro explícito dos sons usados (require estático → bundler embute só esses).
 * Pasta origem indica o tipo: impact/ = SFX, ui/ = cliques, rpg/ = objetos, voice/ = vozes.
 */

export const SFX = {
  // Passos
  stepConcrete: [
          require('../../assets/Audio/impact/footstep_concrete_000.mp3'),
          require('../../assets/Audio/impact/footstep_concrete_001.mp3'),
          require('../../assets/Audio/impact/footstep_concrete_002.mp3'),
          require('../../assets/Audio/impact/footstep_concrete_003.mp3'),
          require('../../assets/Audio/impact/footstep_concrete_004.mp3'),
  ] as const,
  stepGrass: [
          require('../../assets/Audio/impact/footstep_grass_000.mp3'),
          require('../../assets/Audio/impact/footstep_grass_001.mp3'),
          require('../../assets/Audio/impact/footstep_grass_002.mp3'),
          require('../../assets/Audio/impact/footstep_grass_003.mp3'),
          require('../../assets/Audio/impact/footstep_grass_004.mp3'),
  ] as const,
  stepWood: [
          require('../../assets/Audio/impact/footstep_wood_000.mp3'),
          require('../../assets/Audio/impact/footstep_wood_001.mp3'),
          require('../../assets/Audio/impact/footstep_wood_002.mp3'),
  ] as const,

  // Impactos de veículo / objetos
  metalHit: [
          require('../../assets/Audio/impact/impactMetal_medium_000.mp3'),
          require('../../assets/Audio/impact/impactMetal_medium_001.mp3'),
          require('../../assets/Audio/impact/impactMetal_heavy_000.mp3'),
          require('../../assets/Audio/impact/impactPlate_medium_000.mp3'),
  ] as const,
  glassBreak: [
          require('../../assets/Audio/impact/impactGlass_light_000.mp3'),
          require('../../assets/Audio/impact/impactGlass_medium_000.mp3'),
          require('../../assets/Audio/impact/impactGlass_medium_001.mp3'),
  ] as const,
  bodyHit: [
          require('../../assets/Audio/impact/impactPunch_medium_000.mp3'),
          require('../../assets/Audio/impact/impactSoft_medium_000.mp3'),
  ] as const,

  // UI — switch1+ (mais longos; clicks curtos falham no Android)
  uiClick: [
    require('../../assets/Audio/ui/switch1.mp3'),
    require('../../assets/Audio/ui/switch2.mp3'),
    require('../../assets/Audio/ui/switch5.mp3'),
  ] as const,
  uiSwitch: [
    require('../../assets/Audio/ui/switch3.mp3'),
    require('../../assets/Audio/ui/switch4.mp3'),
    require('../../assets/Audio/ui/switch6.mp3'),
  ] as const,

  // Portas / objetos (roubo de carro)
  doorOpen: require('../../assets/Audio/rpg/doorOpen_1.mp3'),
  doorClose: require('../../assets/Audio/rpg/doorClose_1.mp3'),

  // Trânsito / alerta — buzina procedural de dois tons sustentados.
  carHorn: require('../../assets/Audio/generated/car_horn.wav'),
  // Apoio aéreo: loop de 1s de pás, disparado como one-shot com throttling.
  heliRotor: require('../../assets/Audio/generated/heli_rotor.wav'),
  softStep: [
    require('../../assets/Audio/impact/footstep_carpet_000.mp3'),
    require('../../assets/Audio/impact/footstep_carpet_001.mp3'),
    require('../../assets/Audio/impact/footstep_carpet_002.mp3'),
  ] as const,

  // Movimento / exploração (gerado por tools/generate-sfx.js --exploration)
  jump: require('../../assets/Audio/generated/jump.wav'),
  land: require('../../assets/Audio/generated/land.wav'),
  vault: require('../../assets/Audio/generated/vault.wav'),
  death: require('../../assets/Audio/generated/death.wav'),
  animalCall: require('../../assets/Audio/generated/animal_call.wav'),

  // Combate (gerado por tools/generate-sfx.js)
  punch: require('../../assets/Audio/generated/punch.wav'),
  explosion: require('../../assets/Audio/generated/explosion.wav'),
  pistolShot: require('../../assets/Audio/generated/pistol_shot.wav'),
  revolverShot: require('../../assets/Audio/generated/revolver_shot.wav'),
  smgShot: require('../../assets/Audio/generated/smg_shot.wav'),
  microShot: require('../../assets/Audio/generated/micro_shot.wav'),
  rifleShot: require('../../assets/Audio/generated/rifle_shot.wav'),
  sniperShot: require('../../assets/Audio/generated/sniper_shot.wav'),
  shotgunShot: require('../../assets/Audio/generated/shotgun_blast.wav'),
  batSwing: require('../../assets/Audio/generated/bat_swing.wav'),
  batHit: require('../../assets/Audio/generated/bat_hit.wav'),
  weaponReload: require('../../assets/Audio/generated/weapon_reload.wav'),
  weaponEmpty: require('../../assets/Audio/generated/weapon_empty.wav'),

  // Clima (gerado por tools/generate-sfx.js --weather)
  thunder: require('../../assets/Audio/generated/thunder.wav'),
  // Aviso de clima severo (gerado por tools/generate-sfx.js --hazards)
  weatherAlert: require('../../assets/Audio/generated/weather_alert.wav'),

  // Pickups / missões (Kenney rpg + jingles)
  coin: [
    require('../../assets/Audio/rpg/handleCoins.mp3'),
    require('../../assets/Audio/rpg/handleCoins2.mp3'),
  ] as const,
  healthPickup: require('../../assets/Audio/ui/switch20.mp3'),
  missionStart: require('../../assets/Audio/ui/switch7.mp3'),
  missionSuccess: require('../../assets/Audio/jingles/Hit jingles/jingles_HIT00.mp3'),
  missionFail: require('../../assets/Audio/jingles/Pizzicato jingles/jingles_PIZZI00.mp3'),
  busted: require('../../assets/Audio/jingles/8-Bit jingles/jingles_NES05.mp3'),
  wasted: require('../../assets/Audio/jingles/8-Bit jingles/jingles_NES13.mp3'),
} as const;

export const AMBIENT = {
  cityDay: require('../../assets/Audio/ambiente/ambient_city_day.mp3'),
  cityNight: require('../../assets/Audio/generated/ambient_city_night.wav'),
  forestDay: require('../../assets/Audio/generated/forest_day.wav'),
  forestNight: require('../../assets/Audio/generated/forest_night.wav'),
  // Original lightweight regional beds: tools/generate-sfx.js --regions.
  coastDay: require('../../assets/Audio/generated/coast_day.wav'),
  coastNight: require('../../assets/Audio/generated/coast_night.wav'),
  industryDay: require('../../assets/Audio/generated/industry_day.wav'),
  industryNight: require('../../assets/Audio/generated/industry_night.wav'),
  countryDay: require('../../assets/Audio/generated/country_day.wav'),
  countryNight: require('../../assets/Audio/generated/country_night.wav'),
  pinewoodDay: require('../../assets/Audio/generated/pinewood_day.wav'),
  pinewoodNight: require('../../assets/Audio/generated/pinewood_night.wav'),
  savannaDay: require('../../assets/Audio/generated/savanna_day.wav'),
  savannaNight: require('../../assets/Audio/generated/savanna_night.wav'),
  desertDay: require('../../assets/Audio/generated/desert_day.wav'),
  desertNight: require('../../assets/Audio/generated/desert_night.wav'),
  rain: require('../../assets/Audio/chuva/rain_storm.mp3'),
  // Neve não faz barulho de água: o leito do clima vira vento contínuo.
  wind: require('../../assets/Audio/generated/wind_loop.wav'),
  // Clima severo (gerado por tools/generate-sfx.js --hazards): o mesmo canal troca de leito.
  tornado: require('../../assets/Audio/generated/tornado_loop.wav'),
  wave: require('../../assets/Audio/generated/wave_loop.wav'),
  fireworksDistant: require('../../assets/Audio/fogos-artificio/fireworks_distant.mp3'),
  fireworksClose: require('../../assets/Audio/fogos-artificio/fireworks_close.mp3'),
} as const;

/** Loops contínuos por canal (motor, sirene) com volume dinâmico. */
export const LOOPS = {
  engine: require('../../assets/Audio/generated/engine_loop.wav'),
  siren: require('../../assets/Audio/generated/siren_loop.wav'),
} as const;

/** Um só leito de clima por vez: chuva, vento, tornado ou a onda do tsunami. */
export type WeatherBed = 'rain' | 'wind' | 'tornado' | 'wave';

export type LoopKey = keyof typeof LOOPS;
export type LoopChannel = 'engine' | 'siren';

export type SfxKey = keyof typeof SFX;
export type AmbientKey = keyof typeof AMBIENT;
