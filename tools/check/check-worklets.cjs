// Run: node tools/check/check-worklets.cjs
// Guarda estática do lado da UI thread: todo trabalho de `useDerivedValue` roda no runtime
// nativo do Reanimated, onde um import de módulo NÃO existe. A web roda tudo no mesmo
// contexto e nunca reclama — no device o app morre com "x is not a function". É assim que o
// `worldToScreen` da câmera derrubou o boot na tela do jogador.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const srcRoot = path.resolve(__dirname, '../../src');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(file);
  }
})(srcRoot);

const HOOKS = ['useDerivedValue', 'useAnimatedStyle', 'useAnimatedProps', 'useAnimatedGestureHandler'];
/** Expostos pelo próprio runtime da UI (Skia injeta `Skia`, Reanimated injeta os helpers). */
const RUNTIME_GLOBALS = new Set(['Skia', 'interpolate', 'extrapolate', 'clamp', 'Easing',
  'cancelAnimation', 'withTiming', 'withSpring', 'withSequence', 'withDelay', 'withDecay',
  'measure', 'getRelativeMousePosition', 'toDataURL']);

const read = (file) => fs.readFileSync(file, 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Fim da chamada cujo `(` está em `open`, casando parênteses e ignorando strings/comentários. */
function callEnd(text, open) {
  let depth = 0, i = open, quote = null;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && next === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    else if (c === '/' && next === '*') { i = text.indexOf('*/', i); if (i < 0) break; i += 2; continue; }
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return text.length;
}

/** Nome → módulo de cada import de valor (sem `import type`). */
function importsOf(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    for (let raw of m[1].split(',')) {
      raw = raw.trim();
      if (!raw || raw.startsWith('type ')) continue;
      const name = raw.split(/\s+as\s+/).pop().trim();
      if (/^[a-z_$][\w$]*$/.test(name)) out.set(name, m[2]);
    }
    const self = line.match(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/);
    if (self) out.set(self[1], self[2]);
  }
  return out;
}

/** Funções registradas como worklet: a declaração começa com a diretiva 'worklet'. */
const workletCache = new Map();
function registeredWorklets(file) {
  if (workletCache.has(file)) return workletCache.get(file);
  const found = new Set();
  const text = read(file);
  for (const m of text.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)[^{]*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]worklet['"]/g)) {
    found.add(m[1]);
  }
  // `export const nome = (...) => { 'worklet'; ... }` também é registro válido.
  for (const m of text.matchAll(/(?:export\s+)?const\s+([a-zA-Z_$][\w$]*)\s*=[^\n]*=>\s*\{?\s*['"]worklet['"]/g)) {
    found.add(m[1]);
  }
  workletCache.set(file, found);
  return found;
}

function resolveLocal(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Apaga comentários preservando o tamanho do texto, para as posições continuarem valendo. */
function blankComments(text) {
  const out = text.split('');
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i], next = text[i + 1];
    if (quote) {
      if (c === '\\') i += 2;
      else if (c === quote) { quote = null; i += 1; }
      else i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i += 1; continue; }
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let k = i; k < stop; k++) if (text[k] !== '\n') out[k] = ' ';
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Código puro: nem comentário nem string, só o que a UI thread executa. */
function stripNoise(text) {
  return blankComments(text).replace(
    /(['"`])(?:\\.|(?!\1)[^\\])*?\1/g,
    (m, q) => q + ' '.repeat(Math.max(0, m.length - 2)) + q,
  );
}

/** Fim do bloco `{...}` que abre em `brace`, casando chaves fora de strings e comentários. */
function blockEnd(text, brace) {
  let depth = 0, i = brace;
  while (i < text.length) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return text.length;
}

/**
 * Regiões de worklet: o corpo de cada hook e o corpo de toda função marcada 'worklet'.
 * É o recorte onde o código vai rodar do lado nativo — por isso a análise ignora
 * comentários e strings: o que importa é o que o Reanimated serializa.
 */
function workletRegions(source) {
  const text = blankComments(source);
  const regions = [];
  for (const hook of HOOKS) {
    for (const m of text.matchAll(new RegExp(`${hook}\\s*(?:<[^>]*>)?\\s*\\(`, 'g'))) {
      const open = text.indexOf('(', m.index + hook.length);
      regions.push([m.index, callEnd(text, open), hook]);
    }
  }
  for (const m of text.matchAll(/'worklet'/g)) {
    // A diretiva é a primeira instrução do corpo: a chave mais próxima antes dela abre o bloco.
    const brace = text.lastIndexOf('{', m.index);
    if (brace < 0) continue;
    regions.push([brace, blockEnd(text, brace), 'worklet']);
  }
  return regions;
}

/** Funções de topo de módulo: só o que começa na coluna 0 é escopo do arquivo inteiro. */
function topLevelFunctions(text) {
  const found = new Set();
  for (const m of text.matchAll(/^function\s+([a-zA-Z_$][\w$]*)/gm)) found.add(m[1]);
  for (const m of text.matchAll(/^const\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/gm)) found.add(m[1]);
  return found;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('OK ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.message); }
}

test('nenhum worklet chama função importada de outro módulo sem registro', () => {
  const offenders = [];
  for (const file of files) {
    const text = read(file);
    if (!HOOKS.some((hook) => text.includes(hook)) && !text.includes("'worklet'")) continue;
    const imported = importsOf(text);
    if (!imported.size) continue;
    for (const [start, end, hook] of workletRegions(text)) {
      const body = stripNoise(text.slice(start, end));
      for (const call of body.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const name = call[1];
        if (name === hook || !imported.has(name)) continue;
        const specifier = imported.get(name);
        if (RUNTIME_GLOBALS.has(name)) continue;
        const local = resolveLocal(file, specifier);
        if (local && !registeredWorklets(local).has(name)) {
          offenders.push(`${path.relative(srcRoot, file)}:${lineOf(text, start + body.indexOf(name))} `
            +`${hook} chama ${name}() de '${specifier}', que não tem a diretiva 'worklet'`);
        }
        if (!local && !specifier.startsWith('.')) {
          offenders.push(`${path.relative(srcRoot, file)}:${lineOf(text, start)} `
            +`${hook} chama ${name}() do pacote externo '${specifier}'`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'worklets dependem de imports que a UI thread não vê:\n'
    + offenders.join('\n'));
});

test('um worklet não pode chamar função do próprio arquivo sem registro', () => {
  const offenders = [];
  for (const file of files) {
    const text = read(file);
    if (!HOOKS.some((hook) => text.includes(hook)) && !text.includes("'worklet'")) continue;
    const helpers = topLevelFunctions(text);
    if (!helpers.size) continue;
    const registered = registeredWorklets(file);
    for (const [start, end] of workletRegions(text)) {
      const body = stripNoise(text.slice(start, end));
      for (const call of body.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const name = call[1];
        if (!helpers.has(name) || registered.has(name)) continue;
        offenders.push(`${path.relative(srcRoot, file)}:${lineOf(text, start + body.indexOf(name))} `
          +`worklet chama ${name}(), função do arquivo sem a diretiva 'worklet'`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a UI thread não enxerga função não registrada:\n'
    + offenders.join('\n'));
});

test('nenhum worklet toca em objetos mutáveis do JS thread', () => {
  // `game`, `spriteStore` e os stores de entrada são instâncias de classe: ao cruzar para a
  // UI thread viram o objeto inacessível do Reanimated, e a leitura que vem delas é `null`
  // ou `undefined` no aparelho — nunca o valor que a web mostra.
  const MUTABLE = ['game', 'spriteStore', 'uiAnalog', 'inputState', 'sound', 'assetMap'];
  const offenders = [];
  for (const file of files) {
    const text = read(file);
    if (!HOOKS.some((hook) => text.includes(hook)) && !text.includes("'worklet'")) continue;
    for (const [start, end, hook] of workletRegions(text)) {
      const body = stripNoise(text.slice(start, end));
      for (const name of MUTABLE) {
        if (!new RegExp(`(?<![.\\w$])${name}\\b`).test(body)) continue;
        offenders.push(`${path.relative(srcRoot, file)}:${lineOf(text, start)} `
          +`${hook} lê ${name} — a UI thread recebe um objeto inacessível, não o jogo`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'worklets capturaram estado mutável:\n' + offenders.join('\n'));
});

test('a projeção iso e a geometria da névoa estão registradas como worklet', () => {
  // A câmera e a névoa calculam na UI thread; se a diretiva sumir, o boot morre no device.
  assert.ok(registeredWorklets(path.resolve(srcRoot, 'world/IsoUtils.ts')).has('worldToScreen'),
    "worldToScreen perdeu a diretiva 'worklet'");
  assert.ok(registeredWorklets(path.resolve(srcRoot, 'systems/FogSystem.ts')).has('fogRadii'),
    "fogRadii perdeu a diretiva 'worklet'");
  assert.ok(registeredWorklets(path.resolve(srcRoot, 'entities/Player.ts')).has('crouchPose'),
    "crouchPose perdeu a diretiva 'worklet'");
});

test('nenhum worklet reimplementa a projeção iso na mão', () => {
  // Os fatores 64/32 repetidos dentro de um worklet foram a antiga fuga do import que não
  // existia na UI thread. Eles continuam batendo com a fórmula oficial, mas nada avisa
  // quando a projeção muda — e iso 2:1 é contrato do jogo, não detalhe de um arquivo.
  const offenders = [];
  const owner = path.resolve(srcRoot, 'world/IsoUtils.ts');
  for (const file of files) {
    // O dono da fórmula é o único lugar onde ela pode ser escrita na mão.
    if (file === owner) continue;
    const text = read(file);
    if (!HOOKS.some((hook) => text.includes(hook)) && !text.includes("'worklet'")) continue;
    for (const [start, end] of workletRegions(text)) {
      const body = stripNoise(text.slice(start, end));
      // Os dois fatores da iso 2:1 juntos só existem na projeção oficial: quem escreve
      // `* 64` e `* 32` no mesmo worklet está refazendo o worldToScreen em casa.
      const inline = /\*\s*64\b/.test(body) && /\*\s*32\b/.test(body);
      if (!inline) continue;
      offenders.push(`${path.relative(srcRoot, file)}:${lineOf(text, start)} `
        +'worklet refaz (x-y)*64 / (x+y)*32 em vez de chamar worldToScreen');
    }
  }
  assert.deepEqual(offenders, [], 'iso duplicada na UI thread:\n' + offenders.join('\n'));
});

console.log(`Worklet checks: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
