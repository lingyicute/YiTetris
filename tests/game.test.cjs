'use strict';
const {test, before, after, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createServer} = require('node:http');
const {chromium, firefox, webkit} = require('playwright');
const browserType = {chromium, firefox, webkit}[process.env.YT_BROWSER || 'chromium'];
if (!browserType) throw new Error('YT_BROWSER must be chromium, firefox or webkit');
const {resolve} = require('node:path');

// YT_HTML allows the same regression suite to be run against an older revision.
const html = readFileSync(process.env.YT_HTML || resolve(__dirname, '../index.html'));
let browser, server, url, page, errors;
before(async () => {
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await browserType.launch({headless: true});
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
beforeEach(async () => {
  page = await browser.newPage();
  errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.addInitScript(() => {
    // Keep real DOM/input/canvas, but explicitly advance animation time in tests.
    window.framesForTest = [];
    window.requestAnimationFrame = cb => window.framesForTest.push(cb);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__YT?.G.cur);
});
afterEach(async () => {
  await page.close();
  assert.deepEqual(errors, [], 'no uncaught browser errors');
});
async function key(code, type = 'keydown', extra = {}) {
  return page.evaluate(({code, type, extra}) => {
    const e = new KeyboardEvent(type, {code, bubbles: true, cancelable: true, ...extra});
    document.dispatchEvent(e);
    return e.defaultPrevented;
  }, {code, type, extra});
}
async function ground() {
  await page.evaluate(() => {
    const {G, CONST} = __YT;
    G.board = Array.from({length: CONST.ROWS}, () => Array(CONST.COLS).fill(null));
    G.cur = {type: 'O', rot: 0, x: 5, y: CONST.ROWS - 2};
    G.lockAcc = 0; G.lockResets = 0; G.dropAcc = 0;
  });
}

test('7-bag contains every tetromino exactly once per bag', async () => {
  const bags = await page.evaluate(() => {
    __YT.G.bag = [];
    return Array.from({length: 40}, () => Array.from({length: 7}, __YT.nextType).sort().join(''));
  });
  assert.ok(bags.every(b => b === 'IJLOSTZ'));
});
test('hold can be used only once until the piece locks', async () => {
  assert.equal(await page.evaluate(() => {
    const {G, doHold} = __YT;
    doHold(); const current = G.cur; doHold();
    return !G.canHold && G.cur === current && G.next.length === 3;
  }), true);
});
test('SRS I kick at the left wall succeeds without collision', async () => {
  assert.equal(await page.evaluate(() => {
    const {G, rotate, collide} = __YT;
    G.cur = {type: 'I', rot: 1, x: -2, y: 3};
    return rotate(-1) && G.cur.rot === 0 && G.cur.x === 0 && !collide('I', 0, 0, 3);
  }), true);
});
test('hard drop awards two points per cell and spawns a new piece', async () => {
  const result = await page.evaluate(() => {
    const {G, hardDrop, CONST} = __YT;
    G.cur = {type: 'O', rot: 0, x: 5, y: 0};
    hardDrop();
    return {score: G.score, expected: (CONST.ROWS - 2) * 2,
      cells: G.board.flat().filter(Boolean).length, queue: G.next.length};
  });
  assert.equal(result.score, result.expected);
  assert.equal(result.cells, 4);
  assert.equal(result.queue, 3);
});
test('Tetris back-to-back and combo use the pre-clear level', async () => {
  const result = await page.evaluate(() => {
    const {G, finishClear, CONST} = __YT;
    G.lines = 8; G.clear = {rows: [10, 11, 12, 13], t: 170}; G.status = 'clearing';
    finishClear(); const first = G.score;
    G.clear = {rows: [10, 11, 12, 13], t: 170}; G.status = 'clearing'; finishClear();
    return {first, total: G.score, level: G.level, rows: G.board.length, expectedRows: CONST.ROWS};
  });
  assert.equal(result.first, 800);
  assert.equal(result.total, 3300);
  assert.equal(result.level, 2);
  assert.equal(result.rows, result.expectedRows);
});
test('invalid record fields are normalized independently; no stored HTML reaches the dialog', async () => {
  const result = await page.evaluate(() => {
    localStorage.setItem('yitetris.best.easy', JSON.stringify({score: '<img id="injected">', lines: 12}));
    const record = __YT.loadBest('easy'); __YT.bestList();
    return {record, injected: !!document.getElementById('injected')};
  });
  assert.deepEqual(result.record, {score: 0, lines: 12});
  assert.equal(result.injected, false);
});
test('records reject strings, negative/fractional/unsafe numbers, null and arrays', async () => {
  assert.equal(await page.evaluate(() => {
    const invalid = ['42', -1, 1.5, 1e30, null, [], {}];
    return invalid.every(value => {
      localStorage.setItem('yitetris.best.easy', JSON.stringify({score: value, lines: value}));
      const b = __YT.loadBest('easy');
      return b.score === 0 && b.lines === 0;
    });
  }), true);
});
test('saveBest recovers corrupt data and preserves independent maxima', async () => {
  assert.deepEqual(await page.evaluate(() => {
    localStorage.setItem('yitetris.best.easy', '{"score":"oops","lines":40}');
    __YT.saveBest('easy', 200, 10);
    return __YT.loadBest('easy');
  }), {score: 200, lines: 40});
});
test('prototype property names are not valid difficulties', async () => {
  await page.evaluate(() => localStorage.setItem('yitetris.diff', '"toString"'));
  await page.reload();
  assert.deepEqual(await page.evaluate(() => ({diff: __YT.G.diff, level: __YT.G.level})), {diff: 'easy', level: 1});
  assert.equal(await page.evaluate(() => { __YT.newGame('__proto__'); return __YT.G.diff; }), 'easy');
});
test('persisted accent hue is derived from the known palette', async () => {
  await page.evaluate(() => localStorage.setItem('yitetris.accent', '{"id":"blue","h":1e300}'));
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--h')), '214');
});
test('every grounded move consumes a lock reset, including multiple moves in one frame', async () => {
  await ground();
  assert.equal(await page.evaluate(() => {
    __YT.tryMove(-1, 0); __YT.tryMove(1, 0); __YT.rotate(1);
    return __YT.G.lockResets;
  }), 3);
});
test('exhausted lock timer survives a slide off a ledge', async () => {
  const result = await page.evaluate(() => {
    const {G, CONST, tryMove, step} = __YT;
    G.cur = {type: 'O', rot: 0, x: 5, y: 5};
    G.board[7][5] = 'J'; G.lockAcc = 490; G.lockResets = CONST.MAX_LOCK_RESETS;
    tryMove(1, 0); step(1); const airborneTimer = G.lockAcc;
    tryMove(-1, 0); step(10);
    return {airborneTimer, locked: G.board[5][5] === 'O'};
  });
  assert.equal(result.airborneTimer, 490);
  assert.equal(result.locked, true);
});
test('an exhausted grounded piece locks after the remaining delay', async () => {
  await ground();
  assert.equal(await page.evaluate(() => {
    const {G, CONST, tryMove, step} = __YT;
    G.lockResets = CONST.MAX_LOCK_RESETS; G.lockAcc = 490;
    tryMove(-1, 0); step(10);
    return G.board[CONST.ROWS - 1][4];
  }), 'O');
});
test('pause freezes a clear immediately and resumes it without losing progress', async () => {
  await page.evaluate(() => { __YT.G.status = 'clearing'; __YT.G.cur = null; __YT.G.clear = {rows: [13], t: 80}; });
  await key('KeyP');
  assert.deepEqual(await page.evaluate(() => ({status: __YT.G.status, t: __YT.G.clear.t})), {status: 'paused', t: 80});
  await key('KeyP');
  assert.equal(await page.evaluate(() => __YT.G.status), 'clearing');
});
test('visibility loss pauses clearing as well as normal play, idempotently', async () => {
  assert.equal(await page.evaluate(() => {
    __YT.G.status = 'clearing'; __YT.G.clear = {rows: [13], t: 50};
    Object.defineProperty(document, 'hidden', {configurable: true, value: true});
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    return __YT.G.status;
  }), 'paused');
});
test('opening a modal pauses the game instead of letting it fall behind the dialog', async () => {
  assert.equal(await page.evaluate(() => { __YT.howTo(); return __YT.G.status; }), 'paused');
});
test('pause clears held input and ignores keys pressed while paused', async () => {
  await key('ArrowLeft'); await key('KeyP'); await key('ArrowRight'); await key('KeyP');
  assert.equal(await page.evaluate(() => {
    const x = __YT.G.cur.x; __YT.step(200); return __YT.G.cur.x === x;
  }), true);
});
test('releasing the newer direction restores the still-held opposite direction', async () => {
  await key('ArrowLeft'); await key('ArrowRight'); await key('ArrowRight', 'keyup');
  assert.equal(await page.evaluate(() => {
    const x = __YT.G.cur.x; __YT.step(150); return __YT.G.cur.x < x;
  }), true);
});
test('releasing one soft-drop alias does not release the other', async () => {
  await key('ArrowDown'); await key('KeyS'); await key('ArrowDown', 'keyup');
  assert.equal(await page.evaluate(() => { __YT.step(40); return __YT.G.score; }), 1);
});
test('browser shortcuts and auto-repeated pause do not toggle the game', async () => {
  assert.equal(await key('KeyP', 'keydown', {ctrlKey: true}), false);
  assert.equal(await page.evaluate(() => __YT.G.status), 'playing');
  await key('KeyP'); await key('KeyP', 'keydown', {repeat: true});
  assert.equal(await page.evaluate(() => __YT.G.status), 'paused');
});
test('lost pointer capture releases a held touch control', async () => {
  await page.evaluate(() => {
    const b = document.querySelector('[data-act="left"]');
    b.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 10, button: 0, bubbles: true, cancelable: true}));
    b.dispatchEvent(new PointerEvent('lostpointercapture', {pointerId: 10}));
  });
  assert.equal(await page.evaluate(() => {
    const x = __YT.G.cur.x; __YT.step(200); return __YT.G.cur.x === x;
  }), true);
});
test('native keyboard activation of a touch button performs its action once', async () => {
  await page.locator('[data-act="hold"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => __YT.G.canHold), false);
});
test('idle paused frames do not repaint the entire board', async () => {
  await key('KeyP');
  assert.equal(await page.evaluate(() => {
    // Flush the initial ResizeObserver layout callback before measuring idle frames.
    window.framesForTest.splice(0).forEach(cb => cb(900));
    const c = document.getElementById('board').getContext('2d');
    let paints = 0; const clear = c.clearRect.bind(c);
    c.clearRect = (...args) => { paints++; clear(...args); };
    for (let i = 0; i < 5; i++) {
      const callbacks = window.framesForTest.splice(0);
      callbacks.forEach(cb => cb(1000 + i * 16));
    }
    return paints;
  }), 0);
});
test('locking partly above the ceiling ends the game without deleting occupied cells', async () => {
  assert.deepEqual(await page.evaluate(() => {
    const {G, lockPiece} = __YT;
    G.cur = {type: 'T', rot: 0, x: 0, y: -1};
    G.board[1][0] = 'J';
    lockPiece();
    return {status: G.status, cells: G.board.flat().filter(Boolean).length};
  }), {status: 'over', cells: 1});
});
test('a board drag handles several cells in one event and ignores a second pointer', async () => {
  assert.equal(await page.evaluate(() => {
    const board = document.getElementById('board');
    const fire = (type, id, x, y) => board.dispatchEvent(new PointerEvent(type,
      {pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true}));
    const x = __YT.G.cur.x, cell = Math.max(20, board._w / __YT.CONST.COLS * .92);
    fire('pointerdown', 1, 100, 100);
    fire('pointerdown', 2, 200, 200);
    fire('pointerup', 2, 200, 200);
    fire('pointermove', 1, 100 + cell * 3.1, 100);
    fire('pointerup', 1, 100 + cell * 3.1, 100);
    return __YT.G.cur.x - x;
  }), 3);
});
test('an old gesture cannot rotate the next piece after a hold', async () => {
  assert.equal(await page.evaluate(() => {
    const board = document.getElementById('board');
    const e = {pointerId: 1, button: 0, clientX: 100, clientY: 100};
    board.dispatchEvent(new PointerEvent('pointerdown', e));
    __YT.doHold();
    board.dispatchEvent(new PointerEvent('pointerup', e));
    return __YT.G.cur.rot;
  }), 0);
});
test('file URL runs offline even when localStorage is unavailable', async () => {
  const offlinePage = await browser.newPage();
  const requests = [], failures = [];
  offlinePage.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  offlinePage.on('pageerror', e => failures.push(e.message));
  await offlinePage.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {get() { throw new DOMException('Denied', 'SecurityError'); }});
  });
  await offlinePage.goto(require('node:url').pathToFileURL(process.env.YT_HTML || resolve(__dirname, '../index.html')).href);
  assert.equal(await offlinePage.evaluate(() => __YT.G.status), 'playing');
  assert.deepEqual(requests, []);
  assert.deepEqual(failures, []);
  await offlinePage.close();
});
for (const width of [320, 390, 768, 1280]) {
  test(`layout at ${width}px keeps board and topbar inside viewport`, async () => {
    await page.setViewportSize({width, height: 844});
    const result = await page.evaluate(async () => {
      await document.fonts.ready;
      __YT.sizeAll();
      const board = document.getElementById('board').getBoundingClientRect();
      const brand = document.querySelector('.brand-name').getBoundingClientRect();
      const tools = document.querySelector('.tools').getBoundingClientRect();
      return {overflow: document.documentElement.scrollWidth > innerWidth,
        boardFits: board.left >= 0 && board.right <= innerWidth,
        square: Math.abs(board.width - board.height) < 1, overlap: brand.right > tools.left};
    });
    assert.deepEqual(result, {overflow: false, boardFits: true, square: true, overlap: false});
  });
}
test('blocked spawn ends the game and saves score and lines independently', async () => {
  assert.deepEqual(await page.evaluate(() => {
    const {G, spawn, loadBest} = __YT;
    G.board[0].fill('J'); G.score = 500; G.lines = 3;
    const success = spawn('O');
    return {success, status: G.status, best: loadBest(G.diff)};
  }), {success: false, status: 'over', best: {score: 500, lines: 3}});
});
test('failed wall movement does not consume a grounded lock reset', async () => {
  await ground();
  assert.deepEqual(await page.evaluate(() => {
    __YT.G.cur.x = 0; __YT.G.lockAcc = 100;
    const moved = __YT.tryMove(-1, 0);
    return {moved, resets: __YT.G.lockResets, timer: __YT.G.lockAcc};
  }), {moved: false, resets: 0, timer: 100});
});
test('all shapes preserve four cells across four rotations', async () => {
  assert.equal(await page.evaluate(() => Object.values(__YT.SHAPES).every(rotations =>
    rotations.length === 4 && rotations.every(m => m.flat().filter(Boolean).length === 4))), true);
});
test('line compaction keeps non-cleared rows in order', async () => {
  assert.deepEqual(await page.evaluate(() => {
    const {G, CONST, finishClear} = __YT;
    G.board[11][0] = 'J'; G.board[12][0] = 'T'; G.board[13].fill('I');
    G.clear = {rows: [13], t: 170}; G.status = 'clearing'; finishClear();
    return {top: G.board[0].every(v => v === null), last: G.board[CONST.ROWS - 1][0],
      previous: G.board[CONST.ROWS - 2][0], score: G.score, lines: G.lines};
  }), {top: true, last: 'T', previous: 'J', score: 100, lines: 1});
});
test('a no-clear placement preserves back-to-back but resets combo', async () => {
  await ground();
  assert.deepEqual(await page.evaluate(() => {
    __YT.G.lastBig = true; __YT.G.combo = 2; __YT.lockPiece();
    return {b2b: __YT.G.lastBig, combo: __YT.G.combo};
  }), {b2b: true, combo: -1});
});
test('a single line breaks back-to-back', async () => {
  assert.equal(await page.evaluate(() => {
    __YT.G.lastBig = true; __YT.G.status = 'clearing'; __YT.G.clear = {rows: [13], t: 170};
    __YT.finishClear(); return __YT.G.lastBig;
  }), false);
});
test('difficulty starting levels and gravity floor remain unchanged', async () => {
  assert.deepEqual(await page.evaluate(() => {
    const levels = ['easy', 'medium', 'hard', 'expert'].map(d => { __YT.newGame(d); return __YT.G.level; });
    return {levels, initial: __YT.gravityMs(1), floor: __YT.gravityMs(100)};
  }), {levels: [1, 4, 7, 10], initial: 1000, floor: 55});
});
test('theme and accent changes do not reset the current game', async () => {
  assert.equal(await page.evaluate(() => {
    const before = JSON.stringify(__YT.G);
    __YT.setTheme('dark'); __YT.setAccent('blue');
    return JSON.stringify(__YT.G) === before;
  }), true);
});
test('a paused clear completes exactly once after resume', async () => {
  await page.evaluate(() => {
    const {G} = __YT;
    G.board[13].fill('I'); G.status = 'clearing'; G.cur = null; G.clear = {rows: [13], t: 80};
  });
  await key('KeyP');
  assert.equal(await page.evaluate(() => {
    __YT.finishClear(); __YT.step(500); return __YT.G.clear.t;
  }), 80);
  await key('KeyP');
  assert.deepEqual(await page.evaluate(() => {
    __YT.finishClear(); __YT.finishClear();
    return {status: __YT.G.status, lines: __YT.G.lines, score: __YT.G.score};
  }), {status: 'playing', lines: 1, score: 100});
});
test('keyboard menu activation and modal focus trap work together', async () => {
  await page.locator('#menuBtn').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#menuPop').isVisible(), true);
  await page.locator('[data-menu="how"]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#modal').isVisible(), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-ok')), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-ok')), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#modal').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'menuBtn');
});
test('Space on a focused control activates the control, not hard drop', async () => {
  await page.locator('#themeBtn').focus(); await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => __YT.G.board.flat().filter(Boolean).length), 0);
});
test('restart shortcut repeats are ignored', async () => {
  assert.equal(await page.evaluate(() => {
    __YT.G.score = 123;
    document.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyR', repeat: true}));
    return __YT.G.score;
  }), 123);
});
for (const [width, height] of [[620, 700], [844, 390], [1024, 600]]) {
  test(`landscape layout ${width}x${height} does not overflow horizontally`, async () => {
    await page.setViewportSize({width, height});
    assert.equal(await page.evaluate(() => {
      __YT.sizeAll();
      return document.documentElement.scrollWidth <= innerWidth;
    }), true);
  });
}
test('seeded action sequences preserve board, active-piece, queue and score invariants', async () => {
  assert.equal(await page.evaluate(() => {
    let seed = 0x59e1;
    const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
    Math.random = random;
    const {G, CONST, collide, newGame, finishClear} = __YT;
    const acts = [() => __YT.tryMove(-1, 0), () => __YT.tryMove(1, 0),
      () => __YT.rotate(1), () => __YT.rotate(-1), () => __YT.step(64),
      () => __YT.hardDrop(), () => __YT.doHold()];
    for (let i = 0; i < 5000; i++) {
      if (G.status === 'over') newGame();
      if (G.status === 'clearing') finishClear();
      acts[Math.floor(random() * acts.length)]();
      if (G.board.length !== CONST.ROWS || G.board.some(row => row.length !== CONST.COLS)) return false;
      if (G.board.flat().some(v => v !== null && !'IJLOSTZ'.includes(v))) return false;
      if (G.next.length !== 3 || G.lockResets > CONST.MAX_LOCK_RESETS) return false;
      if (!Number.isSafeInteger(G.score) || G.score < 0) return false;
      if (G.cur && collide(G.cur.type, G.cur.rot, G.cur.x, G.cur.y)) return false;
    }
    return true;
  }), true);
});

// real event ordering and frame partitioning, not just end states.
test('landing starts lock time at the landing event, not at the start of the frame', async () => {
  assert.equal(await page.evaluate(() => {
    const {G, CONST, step} = __YT;
    G.cur = {type: 'O', rot: 0, x: 5, y: CONST.ROWS - 3};
    G.dropAcc = 990;
    step(10);
    return G.lockAcc;
  }), 0);
});
test('DAS retains time past the initial delay across different frame partitions', async () => {
  assert.deepEqual(await page.evaluate(() => {
    const {G, newGame, step} = __YT;
    function run(frames) {
      newGame(); G.cur = {type: 'O', rot: 0, x: 10, y: 0};
      document.dispatchEvent(new KeyboardEvent('keydown', {code: 'ArrowLeft'}));
      frames.forEach(step);
      return G.cur.x;
    }
    return [run(Array(5).fill(64)), run(Array(20).fill(16)), run([320])];
  }), [4, 4, 4]);
});
test('soft drop and gravity use the same elapsed timeline at the gravity floor', async () => {
  assert.deepEqual(await page.evaluate(() => {
    const {G, newGame, step} = __YT;
    function run(frames) {
      newGame(); G.level = 100; G.cur = {type: 'O', rot: 0, x: 5, y: 0};
      document.dispatchEvent(new KeyboardEvent('keydown', {code: 'ArrowDown'}));
      frames.forEach(step);
      return {y: G.cur.y, score: G.score, gravity: G.dropAcc};
    }
    return [run(Array(4).fill(64)), run(Array(16).fill(16))];
  }), [{y: 6, score: 6, gravity: 16}, {y: 6, score: 6, gravity: 16}]);
});
test('a blocked DAS repeat does not leave a burst of catch-up moves for the next piece', async () => {
  assert.equal(await page.evaluate(() => {
    const {G, step, spawn} = __YT;
    G.cur = {type: 'O', rot: 0, x: 0, y: 0};
    document.dispatchEvent(new KeyboardEvent('keydown', {code: 'ArrowLeft'}));
    for (let i = 0; i < 40; i++) step(64);
    spawn('O'); const x = G.cur.x;
    step(1);
    return x - G.cur.x;
  }), 0);
});
test('keyboard focus stays in an open popover and Escape returns it to the opener', async () => {
  await page.locator('#menuBtn').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.getElementById('menuPop').contains(document.activeElement)), true);
  for (let i = 0; i < 7; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('menuPop').contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'menuBtn');
  assert.equal(await page.locator('#menuPop').isVisible(), false);
});
test('a captured board click completing after blur must not resume the game', async () => {
  const box = await page.locator('#board').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  assert.equal(await page.evaluate(() => __YT.G.status), 'paused');
});
test('a real touch-pad click acts once, without a compatibility-click duplicate', async () => {
  await page.evaluate(() => { __YT.G.cur = {type: 'T', rot: 0, x: 5, y: 0}; });
  await page.locator('[data-act="cw"]').click();
  assert.equal(await page.evaluate(() => __YT.G.cur.rot), 1);
});
test('a completed clear gives the remaining frame time to the new piece', async () => {
  assert.deepEqual(await page.evaluate(() => {
    const {G, step} = __YT;
    G.cur = null; G.board[13].fill('I'); G.status = 'clearing'; G.clear = {rows: [13], t: 160};
    step(40);
    return {status: G.status, lines: G.lines, drop: G.dropAcc};
  }), {status: 'playing', lines: 1, drop: 30});
});
test('locking gives the remaining frame time to the new piece', async () => {
  await ground();
  assert.equal(await page.evaluate(() => {
    __YT.G.lockAcc = 490; __YT.step(30); return __YT.G.dropAcc;
  }), 20);
});
test('time partition invariance spans lock, clear animation and the next spawn', async () => {
  assert.equal(await page.evaluate(() => {
    const {G, newGame, step} = __YT;
    const run = frames => {
      Math.random = () => .5; newGame();
      G.board[13].fill('J'); G.board[13][5] = G.board[13][6] = null;
      G.cur = {type: 'O', rot: 0, x: 5, y: 12}; G.lockAcc = 490;
      frames.forEach(step);
      return JSON.stringify(G);
    };
    const coarse = run([320]), fine = run(Array(20).fill(16));
    const state = JSON.parse(coarse);
    return coarse === fine && state.status === 'playing' && state.lines === 1 && state.dropAcc === 140;
  }), true);
});
test('palette popover traps reverse Tab and restores focus on dismissal', async () => {
  await page.locator('#paletteBtn').click();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-accent')), 'red');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-accent')), 'purple');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'paletteBtn');
});
test('modal Tab handling also includes editable controls', async () => {
  await page.evaluate(() => __YT.openModal({title: 'Test', body: '<input id="modalInput">'}));
  await page.locator('#modalInput').focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-ok')), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'modalInput');
});
