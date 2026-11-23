const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildCatalog } = require('../scripts/build-catalog.cjs');

function browser(options = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const classSet = new Set();
      elements.set(id, {
        value: '',
        innerHTML: '',
        focus() {},
        classList: {
          add(cls) { classSet.add(cls); },
          remove(cls) { classSet.delete(cls); },
          contains(cls) { return classSet.has(cls); }
        },
        style: {},
        addEventListener() {}
      });
    }
    return elements.get(id);
  };
  const windowListeners = new Map();
  const historyEntries = [{ state: options.initialState ? JSON.parse(JSON.stringify(options.initialState)) : null, url: 'http://localhost/' }];
  let historyIndex = 0;
  const history = {
    get state() { return historyEntries[historyIndex]?.state ?? null; },
    get length() { return historyEntries.length; },
    pushState(state, title, url) {
      historyEntries.splice(historyIndex + 1);
      historyEntries.push({ state: JSON.parse(JSON.stringify(state)), url: url || 'http://localhost/' });
      historyIndex = historyEntries.length - 1;
    },
    replaceState(state, title, url) {
      historyEntries[historyIndex] = { state: JSON.parse(JSON.stringify(state)), url: url || historyEntries[historyIndex]?.url || 'http://localhost/' };
    },
    // Traversals are resolved against the entry current at processing time, like a real
    // browser. With options.asyncHistory they are queued until flushHistory() runs, which
    // reproduces the asynchronous gap between history.back() and popstate.
    back() { queueTraversal(-1); },
    forward() { queueTraversal(1); },
    go(delta) { queueTraversal(delta); }
  };
  const traversalQueue = [];
  let dropBackCount = options.dropPopstate ? Infinity : 0;
  function dropNextBack(n = 1) {
    dropBackCount = n;
  }
  function runTraversal(delta) {
    const target = historyIndex + delta;
    if (target < 0 || target >= historyEntries.length) return;
    historyIndex = target;
    (windowListeners.get('popstate') || []).forEach(fn => fn({ state: history.state }));
  }
  function queueTraversal(delta) {
    if (delta < 0 && dropBackCount > 0) {
      dropBackCount -= 1;
      return;
    }
    if (options.asyncHistory) traversalQueue.push(delta);
    else runTraversal(delta);
  }
  function flushHistory() {
    while (traversalQueue.length) runTraversal(traversalQueue.shift());
  }

  let nextTimerId = 1;
  const timers = new Map();
  function setTimeoutMock(fn, delay = 0) {
    const id = nextTimerId++;
    timers.set(id, { id, fn, delay });
    return id;
  }
  function clearTimeoutMock(id) {
    timers.delete(id);
  }
  function stepTimer() {
    const first = timers.values().next().value;
    if (!first) return false;
    timers.delete(first.id);
    first.fn();
    return true;
  }
  function flushTimers() {
    const snapshot = [...timers.values()];
    for (const t of snapshot) {
      if (!timers.has(t.id)) continue;
      timers.delete(t.id);
      t.fn();
    }
  }

  const win = {
    scrollTo(arg) { win.lastScroll = arg; win.scrollCalls.push(arg); },
    lastScroll: null,
    scrollCalls: [],
    scrollY: 0,
    location: { href: 'http://localhost/' },
    history,
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    addEventListener(evt, fn) {
      if (!windowListeners.has(evt)) windowListeners.set(evt, []);
      windowListeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      if (windowListeners.has(evt)) {
        const arr = windowListeners.get(evt).filter(cb => cb !== fn);
        windowListeners.set(evt, arr);
      }
    },
    dispatchPopState(stateObj) {
      const listeners = windowListeners.get('popstate') || [];
      listeners.forEach(fn => fn({ state: stateObj }));
    }
  };

  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { style: {} },
      activeElement: null,
      contains: () => true
    },
    window: win,
    fetch: () => options.catalog
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(options.catalog) })
      : new Promise(() => {})
  });
  const html = fs.readFileSync('index.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return {
    element,
    run: code => vm.runInContext(code, context),
    window: win,
    history,
    flushHistory,
    dropNextBack,
    stepTimer,
    flushTimers,
    timerCount: () => timers.size,
    historyEntries,
    entryIndex: () => historyIndex
  };
}

test('clearing and changing search restores all source items after zero matches', () => {
  const b = browser();
  b.run(`state.data = { recentFolders: [], repository: { rawBase: 'https://example.com/' } }; state.items = [{name:'Alpha',type:'image',path:'a.png'}, {name:'Beta',type:'image',path:'b.png'}]; state.current='Test';`);
  b.element('browser-sort').value = 'az';
  b.element('browser-search').value = 'alpha'; b.run('applyControls()');
  assert.equal(b.run('state.visibleItems.length'), 1);
  b.element('browser-search').value = 'missing'; b.run('applyControls()');
  assert.equal(b.run('state.visibleItems.length'), 0);
  b.element('browser-search').value = 'beta'; b.run('applyControls()');
  assert.equal(b.run('state.visibleItems[0].name'), 'Beta');
  b.element('browser-search').value = ''; b.run('applyControls()');
  assert.equal(b.run('state.visibleItems.length'), 2);
});

test('gallery uses filtered order and a resized preview with original link', () => {
  const b = browser();
  b.run(`state.data = { recentFolders: [], metadata: {'b.png':{size:2500000}}, repository:{rawBase:'https://example.com/'} }; state.visibleItems = [{name:'Beta',type:'image',path:'b.png'}]; openCurrent('b.png');`);
  assert.match(b.element('fullImage').src, /wsrv\.nl/);
  assert.match(b.element('fullImage').src, /w=800/);
  assert.equal(b.element('download-original').href, 'https://example.com/b.png');
  assert.match(b.element('download-original').textContent, /2.5 MB/);
});

test('new files enter catalog, removed files leave, folder dates propagate', () => {
  const data = buildCatalog({ files:['old.png'], covers:{ A:'cover/a.jpg' }, recentFolders:[] }, [{path:'Render 2.0/A/Alpha/1.png',size:10}, {path:'Render 2.0/A/Sunbringer/1.png',size:20}, {path:'cover/a.jpg',size:1}], file => file.includes('Sunbringer') ? '2026-09-02T00:00:00.000Z' : '2026-08-01T00:00:00.000Z');
  assert.equal(data.files.length, 2);
  assert.equal(data.recentRenders[0].name, 'Sunbringer');
  assert.equal(data.recentFolders[0].updatedAt, '2026-09-02T00:00:00.000Z');
  const b = browser(); b.run('state.data = ' + JSON.stringify(data));
  assert.equal(b.run('buildTree(state.data.files).updatedAt'), '2026-09-02T00:00:00.000Z');
});

test('search finds nested characters and dates sort independently of filenames', () => {
  const b = browser();
  assert.equal(b.run(`matchesSearch({name:'Series',children:[{name:'Character',children:[{name:'Sunbringer.png'}]}]}, 'sunbringer')`), true);
  assert.equal(b.run(`sortItems([{name:'A',updatedAt:'2026-01-01'},{name:'Z',updatedAt:'2026-09-01'}], 'newest')[0].name`), 'Z');
});

test('catalog CLI reads real tracked paths with spaces and commit timestamps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-catalog-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding:'utf8' });
  git(['init']);
  fs.mkdirSync(path.join(dir, 'Render 2.0/Series/Character'), {recursive:true});
  fs.writeFileSync(path.join(dir, 'Render 2.0/Series/Character/1.png'), 'fixture');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({covers:{},recentFolders:[]}));
  git(['add','.']);
  git(['-c','user.name=Catalog Test','-c','user.email=test@example.com','commit','-m','fixture']);
  execFileSync(process.execPath, [path.resolve('scripts/build-catalog.cjs')], {cwd:dir});
  const data = JSON.parse(fs.readFileSync(path.join(dir,'index.json'),'utf8'));
  assert.equal(data.files[0], 'Render 2.0/Series/Character/1.png');
  assert.equal(data.metadata[data.files[0]].size, 7);
  assert.ok(Number.isFinite(Date.parse(data.metadata[data.files[0]].updatedAt)));
});

test('sortItems provides deterministic newest and oldest ordering with alphabetical tie-breaking', () => {
  const b = browser();
  const tieItems = [
    { name: 'Charlie', updatedAt: '2026-05-01' },
    { name: 'Alice', updatedAt: '2026-05-01' },
    { name: 'Bob', updatedAt: '2026-05-01' }
  ];
  const newestTies = b.run(`JSON.stringify(sortItems(${JSON.stringify(tieItems)}, 'newest').map(x => x.name))`);
  assert.deepEqual(JSON.parse(newestTies), ['Alice', 'Bob', 'Charlie']);

  const oldestTies = b.run(`JSON.stringify(sortItems(${JSON.stringify(tieItems)}, 'oldest').map(x => x.name))`);
  assert.deepEqual(JSON.parse(oldestTies), ['Alice', 'Bob', 'Charlie']);

  const distinctItems = [
    { name: 'Beta', updatedAt: '2026-08-01' },
    { name: 'Alpha', updatedAt: '2026-01-01' },
    { name: 'Gamma', updatedAt: '2026-09-01' }
  ];
  const oldestDistinct = b.run(`JSON.stringify(sortItems(${JSON.stringify(distinctItems)}, 'oldest').map(x => x.name))`);
  assert.deepEqual(JSON.parse(oldestDistinct), ['Alpha', 'Beta', 'Gamma']);

  const newestDistinct = b.run(`JSON.stringify(sortItems(${JSON.stringify(distinctItems)}, 'newest').map(x => x.name))`);
  assert.deepEqual(JSON.parse(newestDistinct), ['Gamma', 'Beta', 'Alpha']);

  const mixedItems = [
    { name: 'NoDateZ' },
    { name: 'DatedA', updatedAt: '2026-05-01' },
    { name: 'NoDateA' },
    { name: 'DatedB', updatedAt: '2026-06-01' }
  ];
  const oldestMixed = b.run(`JSON.stringify(sortItems(${JSON.stringify(mixedItems)}, 'oldest').map(x => x.name))`);
  assert.deepEqual(JSON.parse(oldestMixed), ['DatedA', 'DatedB', 'NoDateA', 'NoDateZ']);

  const newestMixed = b.run(`JSON.stringify(sortItems(${JSON.stringify(mixedItems)}, 'newest').map(x => x.name))`);
  assert.deepEqual(JSON.parse(newestMixed), ['DatedB', 'DatedA', 'NoDateA', 'NoDateZ']);
});

test('buildTree precomputes imageCount, coverPath, and populates folderMap', () => {
  const b = browser();
  const testData = {
    metadata: {
      'Render 2.0/SeriesA/Char1/1.png': { size: 100, updatedAt: '2026-01-10T00:00:00.000Z' },
      'Render 2.0/SeriesA/Char1/2.png': { size: 200, updatedAt: '2026-02-15T00:00:00.000Z' },
      'Render 2.0/SeriesA/Char2/1.png': { size: 300, updatedAt: '2026-03-20T00:00:00.000Z' },
      'Render 2.0/SeriesB/Char3/1.png': { size: 400, updatedAt: '2026-04-25T00:00:00.000Z' }
    }
  };
  b.run('state.data = ' + JSON.stringify(testData));
  b.run('state.root = buildTree(' + JSON.stringify(Object.keys(testData.metadata)) + ')');

  assert.equal(b.run('state.folderMap instanceof Map'), true);
  assert.equal(b.run('state.folderMap.has("Render 2.0")'), true);
  assert.equal(b.run('state.folderMap.has("Render 2.0/SeriesA")'), true);
  assert.equal(b.run('state.folderMap.has("Render 2.0/SeriesA/Char1")'), true);

  assert.equal(b.run('state.folderMap.get("Render 2.0").imageCount'), 4);
  assert.equal(b.run('state.folderMap.get("Render 2.0/SeriesA").imageCount'), 3);
  assert.equal(b.run('state.folderMap.get("Render 2.0/SeriesA/Char1").imageCount'), 2);
  assert.equal(b.run('count(state.folderMap.get("Render 2.0/SeriesA/Char1"))'), 2);

  assert.equal(b.run('state.folderMap.get("Render 2.0/SeriesA/Char1").coverPath'), 'Render 2.0/SeriesA/Char1/1.png');
  assert.equal(b.run('coverPath(state.folderMap.get("Render 2.0/SeriesA/Char1"))'), 'Render 2.0/SeriesA/Char1/1.png');

  assert.equal(b.run('state.folderMap.get("Render 2.0/SeriesA/Char1").updatedAt'), '2026-02-15T00:00:00.000Z');
  assert.equal(b.run('state.folderMap.get("Render 2.0/SeriesA").updatedAt'), '2026-03-20T00:00:00.000Z');
  assert.equal(b.run('state.folderMap.get("Render 2.0").updatedAt'), '2026-04-25T00:00:00.000Z');
});

test('findFolderByNameOrPath resolves folders at every nesting depth', () => {
  const b = browser();
  const testData = {
    metadata: {
      'Render 2.0/SeriesA/Char1/1.png': { size: 100, updatedAt: '2026-01-10T00:00:00.000Z' },
      'Render 2.0/SeriesB/Char2/SubDepth/1.png': { size: 200, updatedAt: '2026-02-10T00:00:00.000Z' }
    }
  };
  b.run('state.data = ' + JSON.stringify(testData));
  b.run('state.root = buildTree(' + JSON.stringify(Object.keys(testData.metadata)) + ')');

  assert.equal(b.run('findFolderByNameOrPath("Render 2.0")?.path'), 'Render 2.0');
  assert.equal(b.run('findFolderByNameOrPath("Render 2.0/SeriesA")?.path'), 'Render 2.0/SeriesA');
  assert.equal(b.run('findFolderByNameOrPath("Render 2.0/SeriesA/Char1")?.path'), 'Render 2.0/SeriesA/Char1');
  assert.equal(b.run('findFolderByNameOrPath("Render 2.0/SeriesB/Char2/SubDepth")?.path'), 'Render 2.0/SeriesB/Char2/SubDepth');

  assert.equal(b.run('findFolderByNameOrPath("SeriesA")?.path'), 'Render 2.0/SeriesA');
  assert.equal(b.run('findFolderByNameOrPath("Char1")?.path'), 'Render 2.0/SeriesA/Char1');
  assert.equal(b.run('findFolderByNameOrPath("SubDepth")?.path'), 'Render 2.0/SeriesB/Char2/SubDepth');

  assert.equal(b.run('findFolderByNameOrPath("Render%202.0%2FSeriesA%2FChar1")?.path'), 'Render 2.0/SeriesA/Char1');

  assert.equal(b.run('findFolderByNameOrPath("NonExistentFolder")'), null);
});

test('committed index.json has valid updatedAt timestamps for all files', () => {
  const data = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  assert.ok(Array.isArray(data.files) && data.files.length > 0);
  for (const file of data.files) {
    const meta = data.metadata[file];
    assert.ok(meta, 'Metadata missing for ' + file);
    assert.ok(typeof meta.size === 'number' && meta.size > 0, 'Size missing or invalid for ' + file);
    assert.ok(typeof meta.updatedAt === 'string', 'updatedAt missing for ' + file);
    assert.ok(Number.isFinite(Date.parse(meta.updatedAt)), 'updatedAt is not valid ISO 8601 for ' + file);
  }
});

test('findFolderByNameOrPath prioritizes top-level series folders over shadowed character subfolders', () => {
  const b = browser();
  const testData = {
    metadata: {
      'Render 2.0/SeriesA/Hero/1.png': { size: 100, updatedAt: '2026-01-10T00:00:00.000Z' },
      'Render 2.0/Hero/Main/1.png': { size: 200, updatedAt: '2026-02-15T00:00:00.000Z' }
    }
  };
  b.run('state.data = ' + JSON.stringify(testData));
  b.run('state.root = buildTree(' + JSON.stringify(Object.keys(testData.metadata)) + ')');

  assert.equal(b.run('findFolderByNameOrPath("Hero")?.path'), 'Render 2.0/Hero');
  assert.equal(b.run('findFolderByNameOrPath("hero")?.path'), 'Render 2.0/Hero');
  assert.equal(b.run('findFolderByNameOrPath("Render 2.0/SeriesA/Hero")?.path'), 'Render 2.0/SeriesA/Hero');
});

test('findFolderByNameOrPath handles case-insensitive and normalized nested canonical paths', () => {
  const b = browser();
  const testData = {
    metadata: {
      'Render 2.0/Arknights EndField/Fluorite/1.png': { size: 100, updatedAt: '2026-01-10T00:00:00.000Z' }
    }
  };
  b.run('state.data = ' + JSON.stringify(testData));
  b.run('state.root = buildTree(' + JSON.stringify(Object.keys(testData.metadata)) + ')');

  assert.equal(b.run('findFolderByNameOrPath("render 2.0/arknights endfield/fluorite")?.path'), 'Render 2.0/Arknights EndField/Fluorite');
  assert.equal(b.run('findFolderByNameOrPath("arknights endfield/fluorite")?.path'), 'Render 2.0/Arknights EndField/Fluorite');
  assert.equal(b.run('findFolderByNameOrPath("Arknights-EndField/Fluorite")?.path'), 'Render 2.0/Arknights EndField/Fluorite');
  assert.equal(b.run('findFolderByNameOrPath("Fluorite")?.path'), 'Render 2.0/Arknights EndField/Fluorite');
});

test('catalog CLI handles paths containing Unicode characters and embedded spaces without quoting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-catalog-unicode-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init']);
  fs.mkdirSync(path.join(dir, 'Render 2.0/作品名/キャラクター [HD]'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Render 2.0/作品名/キャラクター [HD]/桜 1.png'), 'fixture');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ covers: {}, recentFolders: [] }));
  git(['add', '.']);
  git(['-c', 'user.name=Unicode Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'unicode fixture']);
  execFileSync(process.execPath, [path.resolve('scripts/build-catalog.cjs')], { cwd: dir });
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));

  const expectedPath = 'Render 2.0/作品名/キャラクター [HD]/桜 1.png';
  assert.equal(data.files[0], expectedPath);
  assert.ok(data.metadata[expectedPath], 'Metadata missing for ' + expectedPath);
  assert.ok(Number.isFinite(Date.parse(data.metadata[expectedPath].updatedAt)));
});

test('series cover remains correct while nested character cover is independent', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // 1. Sousou No Frieren series retains its cover, while character Frieren does NOT inherit it
  const frierenSeries = b.run('getCover(findFolderByNameOrPath("Sousou No Frieren"))');
  const frierenChar = b.run('getCover(findFolderByNameOrPath("Render 2.0/Sousou No Frieren/Frieren"))');
  assert.equal(frierenSeries, 'cover/Sousou No Frieren.webp');
  assert.equal(frierenChar, 'Render 2.0/Sousou No Frieren/Frieren/1.png');

  // 2. Violet Evergarden series retains its cover, while character Violet Evergarden uses its own render
  const violetSeries = b.run('getCover(findFolderByNameOrPath("Violet Evergarden"))');
  const violetChar = b.run('getCover(findFolderByNameOrPath("Render 2.0/Violet Evergarden/Violet Evergarden"))');
  assert.equal(violetSeries, 'cover/Violet evergarden.webp');
  assert.equal(violetChar, 'Render 2.0/Violet Evergarden/Violet Evergarden/1.png');

  // 3. Empty folder fallback returns empty string
  const emptyCover = b.run('getCover({ name: "Empty", type: "folder", path: "Render 2.0/Series/Empty", coverPath: "" })');
  assert.equal(emptyCover, '');
});

test('parent series badge does not leak to nested folders while character badges remain functional', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // Top-level recent series receives badge
  const seriesBadge = b.run('badge(findFolderByNameOrPath("Arknights EndField"))');
  assert.match(seriesBadge, /badge new/);

  // Nested character folder in the same series receives NO badge
  const charBadge = b.run('badge(findFolderByNameOrPath("Render 2.0/Arknights EndField/Fluorite"))');
  assert.equal(charBadge, '');

  // Legitimate character-specific badge remains functional
  const customCharBadge = b.run('badge({ name: "CustomChar", type: "folder", path: "Render 2.0/Series/CustomChar", status: "update" })');
  assert.match(customCharBadge, /badge update/);

  // childItems sets status only on root children unless item has its own status
  b.run('openFolderByPath("Render 2.0/Arknights EndField")');
  const childStatus = b.run('state.items.find(x => x.name === "Fluorite")?.status');
  assert.equal(childStatus, '');
});

test('phase 2.1 remediation: covers, badges, and folder type guards handle all edge cases', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // 1. Unicode-only top-level folder cover does NOT match first entry in covers ("Attack On Titan")
  // and safely falls back to its own coverPath
  const unicodeTopCover = b.run(`
    getCover({
      name: "作品名",
      type: "folder",
      path: "Render 2.0/作品名",
      coverPath: "Render 2.0/作品名/1.png"
    })
  `);
  assert.equal(unicodeTopCover, 'Render 2.0/作品名/1.png');

  // 2. Character folder with state.root = null does NOT inherit parent series cover
  b.run('state.root = null');
  const nullRootCover = b.run(`
    getCover({
      name: "Violet Evergarden",
      type: "folder",
      path: "Render 2.0/Violet Evergarden/Violet Evergarden",
      coverPath: "Render 2.0/Violet Evergarden/Violet Evergarden/1.png"
    })
  `);
  assert.equal(nullRootCover, 'Render 2.0/Violet Evergarden/Violet Evergarden/1.png');

  // Restore state.root
  b.run('state.root = buildTree(state.data.files)');

  // 3. Case-insensitive parent series collision prevention
  // (e.g. "gotoubun no hanayome" vs "Gotoubun No Hanayome")
  const caseInsensitiveCover = b.run(`
    getCover({
      name: "gotoubun no hanayome",
      type: "folder",
      path: "Render 2.0/Gotoubun No Hanayome/gotoubun no hanayome",
      coverPath: "Render 2.0/Gotoubun No Hanayome/gotoubun no hanayome/1.png"
    })
  `);
  assert.equal(caseInsensitiveCover, 'Render 2.0/Gotoubun No Hanayome/gotoubun no hanayome/1.png');

  // 4. Explicit character cover using full canonical path
  b.run(`state.data.covers["Render 2.0/Arknights EndField/Fluorite"] = "cover/fluorite_canonical.webp"`);
  const fullPathCover = b.run('getCover(findFolderByNameOrPath("Render 2.0/Arknights EndField/Fluorite"))');
  assert.equal(fullPathCover, 'cover/fluorite_canonical.webp');

  // 5. Explicit character cover using relative path ("Series/Character")
  b.run(`delete state.data.covers["Render 2.0/Arknights EndField/Fluorite"]`);
  b.run(`state.data.covers["Arknights EndField/Fluorite"] = "cover/fluorite_relative.webp"`);
  const relPathCover = b.run('getCover(findFolderByNameOrPath("Render 2.0/Arknights EndField/Fluorite"))');
  assert.equal(relPathCover, 'cover/fluorite_relative.webp');

  // 6. Explicit unique character name cover (non-series)
  b.run(`delete state.data.covers["Arknights EndField/Fluorite"]`);
  b.run(`state.data.covers["Fluorite"] = "cover/fluorite_unique.webp"`);
  const uniqueNameCover = b.run('getCover(findFolderByNameOrPath("Render 2.0/Arknights EndField/Fluorite"))');
  assert.equal(uniqueNameCover, 'cover/fluorite_unique.webp');

  // 7. Nested folder colliding with a recentFolders name receives NO badge
  // "Arknights EndField" is in recentFolders, but a nested folder with that name should NOT get the badge
  const collidingNestedBadge = b.run(`
    badge({
      name: "Arknights EndField",
      type: "folder",
      path: "Render 2.0/Other Series/Arknights EndField"
    })
  `);
  assert.equal(collidingNestedBadge, '');

  // 8. Non-folder object rejected by isTopLevelFolder
  const imageIsTop = b.run(`isTopLevelFolder({ name: "1.png", type: "image", path: "Render 2.0/1.png" })`);
  assert.equal(imageIsTop, false);

  const realTopFolder = b.run(`isTopLevelFolder({ name: "Arknights EndField", type: "folder", path: "Render 2.0/Arknights EndField" })`);
  assert.equal(realTopFolder, true);
});

test('phase 3 navigation: Scenario 1 - Home -> Series -> Back -> Home', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // Start at home
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.run('state.history.length'), 0);

  // Open a series from Home
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.current'), 'Sousou No Frieren');
  // Opening from Home must NOT push an empty/phantom Home frame
  assert.equal(b.run('state.history.length'), 0);

  // In-app Back returns directly to Home
  b.run('goBack()');
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.run('state.currentPath'), null);
  assert.equal(b.run('state.current'), null);
  assert.equal(b.run('state.items.length'), 0);
  assert.equal(b.run('state.history.length'), 0);
});

test('phase 3 navigation: Scenario 2 - Home -> Browse -> Series -> Character -> Back -> Series -> Back -> Browse -> Back -> Home', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // Browse all folders (Render 2.0)
  b.run('browseAllFolders()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.history.length'), 0);

  // Open Series
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.history.length'), 1);
  assert.equal(b.run('state.history[0].path'), 'Render 2.0');

  // Open Character
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
  assert.equal(b.run('state.history.length'), 2);
  assert.equal(b.run('state.history[1].path'), 'Render 2.0/Sousou No Frieren');

  // Back to Series
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.history.length'), 1);

  // Back to Browse All
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.history.length'), 0);

  // Back to Home
  b.run('goBack()');
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.run('state.history.length'), 0);
});

test('phase 3 navigation: Scenario 3 - Home -> Series -> Character A -> Back -> Character B -> Back', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  assert.equal(b.run('state.history.length'), 1);

  // Back to Series
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.history.length'), 0);

  // Open Character B (Fern)
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Fern")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Fern');
  assert.equal(b.run('state.history.length'), 1);
  assert.equal(b.run('state.history[0].path'), 'Render 2.0/Sousou No Frieren');

  // Back to Series -> Back to Home
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  b.run('goBack()');
  assert.equal(b.run('state.view'), 'home');
});

test('phase 3 navigation: Scenario 4 - Search -> Open Folder -> Back restores search query and sort selection', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.element('browser-search').value = 'frieren';
  b.element('browser-sort').value = 'za';
  b.run('applyControls()');

  assert.equal(b.run('state.searchQuery'), 'frieren');
  assert.equal(b.run('state.sortBy'), 'za');
  assert.equal(b.run('state.visibleItems.length'), 1);

  // Open matched folder
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  // Child folder resets query and sort
  assert.equal(b.element('browser-search').value, '');
  assert.equal(b.element('browser-sort').value, 'newest');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.run('state.sortBy'), 'newest');

  // Navigate Back: query and sort are fully restored
  b.run('goBack()');
  assert.equal(b.element('browser-search').value, 'frieren');
  assert.equal(b.element('browser-sort').value, 'za');
  assert.equal(b.run('state.searchQuery'), 'frieren');
  assert.equal(b.run('state.sortBy'), 'za');
  assert.equal(b.run('state.visibleItems.length'), 1);
  assert.equal(b.run('state.visibleItems[0].name'), 'Sousou No Frieren');
});

test('phase 3 navigation: Scenario 5 - Search with zero results -> Clear Search -> Navigate', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  const totalCount = b.run('state.items.length');

  b.element('browser-search').value = 'nonexistent_query_xyz';
  b.run('applyControls()');
  assert.equal(b.run('state.visibleItems.length'), 0);

  // Clear search
  b.element('browser-search').value = '';
  b.run('applyControls()');
  assert.equal(b.run('state.visibleItems.length'), totalCount);

  // Navigate to child folder
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.visibleItems.length'), totalCount);
});

test('phase 3 navigation: Scenario 6 - Browser Back and Forward synchronization', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');

  // Trigger browser back
  b.history.back();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');

  // Trigger browser back again
  b.history.back();
  assert.equal(b.run('state.currentPath'), 'Render 2.0');

  // Trigger browser forward
  b.history.forward();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');

  // Trigger browser forward again
  b.history.forward();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
});

test('phase 3 navigation: Scenario 7 - Repeated navigation without duplicate history', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  // Opening the same path repeatedly must be guarded
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  assert.equal(b.run('state.history.length'), 1);

  // Return to Home, then open another series from Home
  b.run('showHome()');
  assert.equal(b.run('state.history.length'), 0);
  assert.equal(b.run('state.items.length'), 0);

  b.run('openFolderByPath("Render 2.0/Arknights EndField")');
  // Must NOT have stale pre-showHome entries
  assert.equal(b.run('state.history.length'), 0);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Arknights EndField');
});

test('phase 3 navigation: Scenario 8 - Gallery open -> Next Image -> Close -> Back does not corrupt folder history', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  assert.equal(b.run('state.history.length'), 0);

  // Open modal gallery
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.run('state.gallery.length > 0'), true);
  b.run('nextImage()');

  // Close modal via close button
  b.run('closeModal()');
  assert.equal(b.element('modal').classList.contains('show'), false);
  assert.equal(b.run('state.history.length'), 0);

  // Back returns to home
  b.run('goBack()');
  assert.equal(b.run('state.view'), 'home');
});

test('phase 3 navigation: Scenario 9 - Folder navigation after sorting restores previous sort', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.element('browser-sort').value = 'az';
  b.run('applyControls()');
  assert.equal(b.run('state.sortBy'), 'az');

  // Open child folder and change sort to 'oldest'
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  assert.equal(b.element('browser-sort').value, 'newest');
  b.element('browser-sort').value = 'oldest';
  b.run('applyControls()');
  assert.equal(b.run('state.sortBy'), 'oldest');

  // Back restores 'az' sort in parent folder
  b.run('goBack()');
  assert.equal(b.element('browser-sort').value, 'az');
  assert.equal(b.run('state.sortBy'), 'az');
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
});

test('phase 3 navigation: Scenario 10 - Direct folder opening through openFolderByPath()', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // Direct cold start opening of nested path
  b.run('openFolderByPath("Sousou No Frieren/Frieren")');
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
  assert.equal(b.run('state.history.length'), 0);

  b.run('goBack()');
  assert.equal(b.run('state.view'), 'home');
});

test('phase 3 navigation: Mandatory Extra 1 - Modal gallery Back priority (browser Back closes modal first)', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');

  // Open modal (pushes a dedicated modal history entry)
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.element('modal').classList.contains('show'), true);

  // Trigger real browser Back (b.history.back()) while modal is open:
  // Priority 1: Closes the modal FIRST, without leaving Frieren folder or corrupting folder history!
  b.history.back();
  assert.equal(b.element('modal').classList.contains('show'), false);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
  assert.equal(b.run('state.history.length'), 2);

  // Subsequent real browser Back: navigates to parent series folder
  b.history.back();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.history.length'), 1);

  // Subsequent real browser Back: navigates to Browse All
  b.history.back();
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.history.length'), 0);

  // Subsequent real browser Back: navigates to Home
  b.history.back();
  assert.equal(b.run('state.view'), 'home');
});

test('phase 3 navigation: Mandatory Extra 2 - Browser Forward after returning to Home restores complete state', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.element('browser-search').value = 'frieren';
  b.element('browser-sort').value = 'az';
  b.run('applyControls()');

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');

  // Go back to Browse All, then to Home
  b.history.back();
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.searchQuery'), 'frieren');

  b.history.back();
  assert.equal(b.run('state.view'), 'home');

  // Browser Forward restores Browse All with query and sort
  b.history.forward();
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.searchQuery'), 'frieren');
  assert.equal(b.run('state.sortBy'), 'az');

  // Browser Forward restores Sousou No Frieren
  b.history.forward();
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
});

test('phase 3 navigation: Mandatory Extra 3 - Modal closing through Escape, close button, and browser Back', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');

  // 1. Close via close button
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.element('modal').classList.contains('show'), true);
  b.run('closeModal()');
  assert.equal(b.element('modal').classList.contains('show'), false);

  // 2. Close via Escape key simulation (calls closeModal)
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.element('modal').classList.contains('show'), true);
  b.run('closeModal({ target: { classList: { contains(c) { return c === "close"; } } } })');
  assert.equal(b.element('modal').classList.contains('show'), false);

  // 3. Close via browser Back: the modal owns a history entry, so Back closes it in place
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.element('modal').classList.contains('show'), true);
  b.history.back();
  assert.equal(b.element('modal').classList.contains('show'), false);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
});

test('phase 3 navigation: Mandatory Extra 4 - Direct URL folder opening followed by Back returns to Home', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // Direct opening of nested character path (e.g. from deep link/URL)
  b.run('openFolderByPath("Render 2.0/Arknights EndField/Fluorite")');
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Arknights EndField/Fluorite');
  assert.equal(b.run('state.history.length'), 0);

  // In-app Back returns cleanly to Home
  b.run('goBack()');
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.run('state.currentPath'), null);
  assert.equal(b.run('state.items.length'), 0);
  assert.equal(b.run('state.history.length'), 0);
});

test('phase 3 navigation: Mandatory Extra 5 - Repeated Back and Forward navigation preserves state integrity', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');

  // Cycle 1: Back twice -> Home -> Forward twice -> Frieren
  b.history.back(); // to Sousou No Frieren
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  b.history.back(); // to Browse All
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  b.history.back(); // to Home
  assert.equal(b.run('state.view'), 'home');

  b.history.forward(); // to Browse All
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  b.history.forward(); // to Sousou No Frieren
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  b.history.forward(); // to Frieren
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');

  // Cycle 2: Repeat Back -> Forward
  b.history.back();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  b.history.forward();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
});

test('phase 3.1 remediation: modal opened from Home closes via browser Back without leaving Home', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // Open modal directly from Home (recent renders)
  b.run('openRecent(0)');
  assert.equal(b.element('modal').classList.contains('show'), true);
  assert.equal(b.run('state.view'), 'home');

  // Browser Back closes modal while remaining on Home
  b.history.back();
  assert.equal(b.element('modal').classList.contains('show'), false);
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.run('state.currentPath'), null);
});

test('phase 3.1 remediation: closing modal via Escape or Close button removes modal history entry cleanly', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  const historyLenBeforeModal = b.history.length;

  // Open modal -> pushes modal entry
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.element('modal').classList.contains('show'), true);

  // Close modal via close button
  b.run('closeModal()');
  assert.equal(b.element('modal').classList.contains('show'), false);
  // Modal history entry is popped cleanly
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');

  // Next browser Back returns to Home (not back to the modal!)
  b.history.back();
  assert.equal(b.run('state.view'), 'home');
});

test('phase 3.1 remediation: browser Forward works after in-app goBack()', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');

  // In-app Back: traverses history.back()
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');

  // Browser Forward is preserved and restores Frieren!
  b.history.forward();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
});

test('phase 3.1 remediation: search and sort changes update browser history via replaceState without drilling down', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  b.element('browser-search').value = 'frieren';
  b.element('browser-sort').value = 'za';
  // Simulates user input event listener with syncHistory: true
  b.run('applyControls({ syncHistory: true })');

  // Verify replaceState updated current history entry immediately
  assert.equal(b.history.state.search, 'frieren');
  assert.equal(b.history.state.sort, 'za');

  // Back to Home
  b.history.back();
  assert.equal(b.run('state.view'), 'home');

  // Forward back to Browse All restores the live search & sort
  b.history.forward();
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.searchQuery'), 'frieren');
  assert.equal(b.run('state.sortBy'), 'za');
  assert.equal(b.element('browser-search').value, 'frieren');
  assert.equal(b.element('browser-sort').value, 'za');
});

test('phase 3.1 remediation: showHome() prevents duplicate Home history entries', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  const initialLen = b.history.length;
  // Calling showHome while already on Home does NOT push new entries
  b.run('showHome()');
  b.run('showHome()');
  b.run('showHome()');
  assert.equal(b.history.length, initialLen);
  assert.equal(b.run('state.view'), 'home');
});

test('phase 3.1 remediation: foreign and malformed history.state are handled safely without crashing', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  // 1. Foreign app state
  b.window.dispatchPopState({ app: 'foreign_app', someOtherData: 123 });
  assert.equal(b.run('state.view'), 'home');

  // 2. Malformed stack (non-array, e.g. string or object)
  b.window.dispatchPopState({
    app: 'render2',
    v: 1,
    view: 'folder',
    path: 'Render 2.0/Sousou No Frieren',
    stack: 'invalid_non_array_stack'
  });
  // Safely restores folder without throwing TypeError
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.history.length'), 0);

  // 3. Null state
  b.window.dispatchPopState(null);
  assert.equal(b.run('state.view'), 'home');
});

test('phase 3.1 remediation: scroll restoration restores saved scrollY value (e.g. 350)', () => {
  const b = browser();
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');

  b.run('browseAllFolders()');
  // User scrolled down to 350 in parent folder
  b.window.scrollY = 350;

  // Drill down to child folder
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');

  // Back to parent folder: restores scrollY 350
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.window.lastScroll?.top, 350);
});

// ---------------------------------------------------------------------------
// Phase 3.2: history reliability (async traversal, modal restore, strict state)
// ---------------------------------------------------------------------------
function loadedBrowser(options = {}) {
  const b = browser(options);
  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');
  return b;
}
const modalShown = b => b.element('modal').classList.contains('show');

test('phase 3.2: initial Home entry is stamped via replaceState without adding an entry', () => {
  const b = browser();
  assert.equal(b.history.length, 1);
  assert.equal(b.history.state.app, 'render2');
  assert.equal(b.history.state.v, 1);
  assert.equal(b.history.state.idx, 0);
  assert.equal(b.history.state.view, 'home');
  assert.equal(b.history.state.path, null);
});

test('phase 3.2: Home -> Series -> in-app Back -> browser Forward restores the Series', () => {
  const b = loadedBrowser();
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('goBack()');
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.history.length, 2, 'in-app Back must traverse, not push');
  assert.equal(b.entryIndex(), 0);
  b.history.forward();
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  // and Back again returns Home, still without growing history
  b.history.back();
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.history.length, 2);
});

test('phase 3.2: Folder -> Modal -> Back -> Forward -> Back restores gallery and image index symmetrically', () => {
  const b = loadedBrowser();
  b.run('openFolderByPath("Render 2.0/Attack On Titan/Levi Ackerman")');
  const files = b.run('JSON.stringify(state.visibleItems.filter(x => x.type === "image").map(x => x.path))');
  const images = JSON.parse(files);
  assert.ok(images.length >= 2, 'fixture folder needs 2+ images');
  b.run('openCurrent(' + JSON.stringify(images[1]) + ')');
  assert.equal(b.run('state.gi'), 1);
  assert.equal(b.history.state.modal.path, images[1]);
  const lenWithModal = b.history.length;

  b.history.back();
  assert.equal(modalShown(b), false);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Attack On Titan/Levi Ackerman');

  b.history.forward();
  assert.equal(modalShown(b), true, 'Forward must reopen the modal');
  assert.equal(b.run('state.gi'), 1);
  assert.equal(b.run('state.gallery[state.gi].path'), images[1]);
  assert.equal(b.history.length, lenWithModal, 'restoration must not add entries');

  b.history.back();
  assert.equal(modalShown(b), false);
  assert.equal(b.history.length, lenWithModal);
});

test('phase 3.2: modal image changes are persisted so Forward restores the viewed image (Home gallery)', () => {
  const b = loadedBrowser();
  b.run('openRecent(1)');
  b.run('nextImage()');
  assert.equal(b.run('state.gi'), 2);
  b.history.back();
  assert.equal(modalShown(b), false);
  assert.equal(b.run('state.view'), 'home');
  b.history.forward();
  assert.equal(modalShown(b), true);
  assert.equal(b.run('state.gi'), 2);
  assert.equal(b.run('state.gallerySource'), 'recent');
});

test('phase 3.2: rapid Escape -> in-app Back resolves to the correct level (async traversal)', () => {
  const b = loadedBrowser({ asyncHistory: true });
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.entryIndex(), 3);

  b.run('closeModal()');              // Escape: closes UI, queues one traversal
  assert.equal(modalShown(b), false);
  b.run('goBack()');                  // queued before the first popstate arrives
  b.flushHistory();

  assert.equal(modalShown(b), false);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.history.length'), 0);
  assert.equal(b.entryIndex(), 1);
  assert.equal(b.history.length, 4, 'no entries added or lost');
  assert.equal(b.run('state._pendingBack'), 0, 'no stale suppression state');
});

test('phase 3.2: repeated in-app Back never walks past the first app entry (async traversal)', () => {
  const b = loadedBrowser({ asyncHistory: true });
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('goBack()'); b.run('goBack()'); b.run('goBack()');
  b.flushHistory();
  assert.equal(b.run('state.view'), 'home');
  assert.equal(b.entryIndex(), 0);
  assert.equal(b.history.length, 2, 'redundant Back requests must not push or traverse extra');
  assert.equal(b.run('state._pendingBack'), 0);
});

test('phase 3.2: rapid modal close -> reopen leaves history and UI consistent (async traversal)', () => {
  const b = loadedBrowser({ asyncHistory: true });
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  b.run('closeModal()');
  // A reopen issued while the close traversal is in flight must wait for it to land
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(modalShown(b), false, 'reopen is deferred while a traversal is pending');
  assert.equal(b.run('state._deferred.length'), 1);
  assert.equal(b.history.length, 3, 'deferred reopen must not push against the entry being left');
  b.flushHistory();
  assert.equal(modalShown(b), true, 'deferred reopen runs after the traversal lands');
  assert.equal(b.run('state._deferred.length'), 0);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
  b.run('closeModal()');
  b.flushHistory();
  assert.equal(modalShown(b), false);
  assert.equal(b.entryIndex(), 1);
  assert.equal(b.run('state._pendingBack'), 0);
});

test('phase 3.2: repeated browser Back/Forward cycles keep state and history length stable', () => {
  const b = loadedBrowser();
  b.run('browseAllFolders()');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  const len = b.history.length;
  for (let i = 0; i < 5; i++) {
    b.history.back(); b.history.back(); b.history.back();
    assert.equal(b.run('state.view'), 'home');
    b.history.forward(); b.history.forward(); b.history.forward();
    assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
    assert.equal(b.run('state.history.length'), 2);
  }
  assert.equal(b.history.length, len);
});

test('phase 3.2: foreign and wrong-version history states are rejected and the entry re-stamped', () => {
  const b = loadedBrowser();
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  const foreign = [
    { path: 'Render 2.0/Sousou No Frieren', view: 'folder' },                       // no namespace
    { app: 'render2', v: 2, view: 'folder', path: 'Render 2.0/Sousou No Frieren' },  // wrong version
    { app: 'other', v: 1, view: 'folder', path: 'Render 2.0/Sousou No Frieren' },
    { app: 'render2', v: 1, view: 'folder' },                                         // folder without path
    { app: 'render2', v: 1, view: 'bogus' },
    'garbage', 42, null
  ];
  for (const s of foreign) {
    b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
    b.window.dispatchPopState(s);
    assert.equal(b.run('state.view'), 'home', 'rejected: ' + JSON.stringify(s));
    assert.equal(b.history.state.app, 'render2');
    assert.equal(b.history.state.view, 'home');
  }
});

test('phase 3.2: malformed fields inside a valid entry are sanitized without crashing', () => {
  const b = loadedBrowser();
  b.window.dispatchPopState({
    app: 'render2', v: 1, view: 'folder', path: 'Render 2.0/Sousou No Frieren',
    search: 123, sort: 'bogus', scrollY: 'x',
    stack: [null, 'x', { path: 7 }, { path: 'Render 2.0', title: 5, sort: 'za', scrollY: 40 }],
    modal: { source: 'nope', gi: 'x', path: {} }
  });
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.sortBy'), 'newest');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.run('state.history.length'), 1);
  assert.equal(b.run('state.history[0].sortBy'), 'za');
});

test('phase 3.2: repeated browseAllFolders() calls add exactly one history entry', () => {
  const b = loadedBrowser();
  b.run('browseAllFolders()'); b.run('browseAllFolders()'); b.run('browseAllFolders()');
  assert.equal(b.history.length, 2);
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.history.length'), 0);
});

test('phase 3.2: browser Back/Forward restore the exact scroll position of each entry', () => {
  const b = loadedBrowser();
  b.run('browseAllFolders()');
  b.window.scrollY = 350;
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.window.scrollY = 120;                       // user scrolled the child folder
  b.run('syncBrowserHistory("replace")');       // what the debounced scroll listener does
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  b.window.scrollY = 0;

  b.history.back();
  assert.equal(b.window.lastScroll.top, 120);
  b.history.back();
  assert.equal(b.window.lastScroll.top, 350);
  b.history.forward();
  assert.equal(b.window.lastScroll.top, 120);
  assert.equal(b.window.lastScroll.behavior, 'auto');
});

test('phase 3.2: reload on a modal entry restores view, history stack and modal without a new entry', async () => {
  const first = loadedBrowser();
  first.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  first.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  first.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  const persisted = JSON.parse(JSON.stringify(first.history.state));

  const catalog = JSON.parse(fs.readFileSync('index.json', 'utf8'));
  const second = browser({ initialState: persisted, catalog });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(second.run('state.view'), 'folder');
  assert.equal(second.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
  assert.equal(second.run('state.history.length'), 1);
  assert.equal(modalShown(second), true);
  assert.equal(second.history.length, 1, 'reload must not add entries');
  assert.equal(second.history.state.idx, 3, 'entry position survives reload');
});

// ---------------------------------------------------------------------------
// Phase 3.3: scroll restoration independent of sameView & stalled traversal
// ---------------------------------------------------------------------------
test('phase 3.3: applyHistoryState() restores scrollY even when sameView is true', () => {
  const b = loadedBrowser();
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  // User scrolls down inside the folder and the debounced scroll listener updates history.state
  b.window.scrollY = 480;
  b.run('syncBrowserHistory("replace")');

  // User opens modal (pushes modal entry for the same folder)
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(modalShown(b), true);

  // Simulate scroll position being perturbed/reset before returning from modal
  b.window.scrollY = 0;
  b.window.lastScroll = null;

  // Browser Back returns to the folder entry where sameView === true
  // (view === "folder", currentPath === folder.path, searchQuery === "", sortBy === "newest")
  b.history.back();
  assert.equal(modalShown(b), false);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
  assert.equal(b.window.lastScroll?.top, 480);
  assert.equal(b.window.lastScroll?.behavior, 'auto');
});

test('phase 3.3: UI re-rendering is separated from scroll position restoration across sameView=true and sameView=false', () => {
  const b = loadedBrowser();
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run(`
    state._renderCount = 0;
    const origRenderItems = renderItems;
    renderItems = function(...args) {
      state._renderCount += 1;
      return origRenderItems.apply(this, args);
    };
  `);

  // 1. Apply history state with sameView === true (same folder, search, sort) but different scrollY
  b.window.lastScroll = null;
  b.run(`applyHistoryState({
    view: "folder",
    path: "Render 2.0/Sousou No Frieren",
    title: "Sousou No Frieren",
    search: "",
    sort: "newest",
    scrollY: 640,
    stack: [],
    modal: null
  })`);
  assert.equal(b.run('state._renderCount'), 0, 'DOM grid must not re-render when sameView is true');
  assert.equal(b.window.lastScroll?.top, 640, 'scrollY must still be restored when sameView is true');
  assert.equal(b.window.lastScroll?.behavior, 'auto');

  // 2. Apply history state with sameView === false (sort changed) and new scrollY
  b.window.lastScroll = null;
  b.run(`applyHistoryState({
    view: "folder",
    path: "Render 2.0/Sousou No Frieren",
    title: "Sousou No Frieren",
    search: "",
    sort: "az",
    scrollY: 215,
    stack: [],
    modal: null
  })`);
  assert.equal(b.run('state._renderCount'), 1, 'DOM grid must re-render when sameView is false');
  assert.equal(b.window.lastScroll?.top, 215, 'scrollY must be restored when sameView is false');
  assert.equal(b.window.lastScroll?.behavior, 'auto');
});

test('phase 3.3: history.back() without popstate cleans up _pendingBack on timeout and runs deferred navigation', () => {
  const b = loadedBrowser();
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(modalShown(b), true);

  // Next history.back() call will silently fail to emit popstate
  b.dropNextBack(1);
  b.run('closeModal()');
  assert.equal(modalShown(b), false);
  assert.equal(b.run('state._pendingBack'), 1);
  assert.equal(b.timerCount(), 1);

  // Navigation issued while stalled traversal is pending gets deferred
  b.run('openFolderByPath("Render 2.0/Attack On Titan")');
  assert.equal(b.run('state._deferred.length'), 1);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');

  // Timeout fires: cleans up _pendingBack, reconciles modal state, and executes deferred navigation
  b.flushTimers();
  assert.equal(b.run('state._pendingBack'), 0);
  assert.equal(b.run('state._backQueue.length'), 0);
  assert.equal(b.run('state._deferred.length'), 0);
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Attack On Titan');
});

test('phase 3.3: goBack() when history.back() produces no popstate falls back cleanly and supports deferred navigation', () => {
  const b = loadedBrowser();
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');

  // 1. Stalled goBack() without deferred navigation falls back to parent folder on timeout
  b.dropNextBack(1);
  b.run('goBack()');
  assert.equal(b.run('state._pendingBack'), 1);
  b.flushTimers();
  assert.equal(b.run('state._pendingBack'), 0);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.run('state.history.length'), 0);

  // 2. Stalled goBack() to Home followed by deferred browseAllFolders()
  b.dropNextBack(1);
  b.run('goBack()');
  assert.equal(b.run('state._pendingBack'), 1);
  b.run('browseAllFolders()');
  assert.equal(b.run('state._deferred.length'), 1);

  b.flushTimers();
  assert.equal(b.run('state._pendingBack'), 0);
  assert.equal(b.run('state._deferred.length'), 0);
  assert.equal(b.run('state.view'), 'folder');
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
});

test('phase 3.3: traversal timeout cleans up only its own ticket and never interferes with newer in-flight or subsequent traversals', () => {
  const b = loadedBrowser({ asyncHistory: true });
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  b.run('openCurrent("Render 2.0/Sousou No Frieren/Frieren/1.png")');
  assert.equal(b.entryIndex(), 3);

  // Traversal #1 (closeModal) drops popstate; Traversal #2 (goBack) is queued in asyncHistory
  b.dropNextBack(1);
  b.run('closeModal()'); // ticket #1 (dropped by browser)
  b.run('goBack()');     // ticket #2 (in-flight in asyncHistory)
  assert.equal(b.run('state._pendingBack'), 2);
  assert.equal(b.timerCount(), 2);

  // Queue a deferred navigation while both tickets are pending
  b.run('openFolderByPath("Render 2.0/Attack On Titan")');
  assert.equal(b.run('state._deferred.length'), 1);

  // Expire ONLY ticket #1's timer while ticket #2 is still in flight
  assert.equal(b.stepTimer(), true);
  assert.equal(b.run('state._pendingBack'), 1, 'timeout of ticket #1 must only decrement its own pending count');
  assert.equal(b.timerCount(), 1, 'ticket #2 timer must remain active');
  assert.equal(b.run('state._deferred.length'), 1, 'deferred navigation must wait for in-flight ticket #2');

  // Now ticket #2's popstate arrives
  b.flushHistory();
  assert.equal(b.run('state._pendingBack'), 0, 'ticket #2 completion reduces _pendingBack to 0');
  assert.equal(b.timerCount(), 0, 'ticket #2 timer is cleared on popstate');
  assert.equal(b.run('state._deferred.length'), 0, 'deferred navigation executes once ticket #2 completes');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Attack On Titan');

  // A subsequent new traversal after timeout + completion works normally without interference
  b.run('goBack()');
  assert.equal(b.run('state._pendingBack'), 1);
  b.flushHistory();
  assert.equal(b.run('state._pendingBack'), 0);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren/Frieren');
});

// ---------------------------------------------------------------------------
// Phase 4: Search Drill-Down Continuity
// ---------------------------------------------------------------------------
function phase4SyntheticCatalog() {
  const files = [
    'Render 2.0/Zenless Zone Zero/Faction/Sunbringer/1.png',
    'Render 2.0/Zenless Zone Zero/Faction/Sunglow/1.png',
    'Render 2.0/Zenless Zone Zero/Anby Demara/1.png',
    'Render 2.0/Alpha/Alpha Sub/1.png',
    'Render 2.0/Alpha/Beta Sub/1.png',
    'Render 2.0/Unicode Series/Üñîçødé Hero/1.png',
    'Render 2.0/Unicode Series/Other Hero/1.png',
    'Render 2.0/Image Match Series/CharY/special_boss_render.png',
    'Render 2.0/Image Match Series/CharY/normal.png',
    'Render 2.0/Image Match Series/CharZ/other.png',
    'Render 2.0/Unrelated/CharU/1.png'
  ];
  const metadata = {};
  files.forEach((f, idx) => {
    metadata[f] = { size: 1000 + idx, updatedAt: `2026-0${(idx % 9) + 1}-01T00:00:00.000Z` };
  });
  return {
    files,
    metadata,
    covers: {},
    recentFolders: [],
    recentRenders: [],
    repository: { rawBase: 'https://example.com/' }
  };
}

function phase4Browser(options = {}) {
  const catalog = options.catalog || phase4SyntheticCatalog();
  const b = browser({ ...options, catalog: undefined });
  b.run('state.data = ' + JSON.stringify(catalog));
  b.run('state.root = buildTree(state.data.files)');
  return b;
}

test('phase 4 (1): descendant-only folder match preserves search', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sunbringer';
  b.run('applyControls({ syncHistory: true })');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'Zenless Zone Zero');

  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Zenless Zone Zero');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.element('browser-search').value, 'sunbringer');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'Faction');
});

test('phase 4 (2): direct folder name match clears search', () => {
  const b = loadedBrowser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'frieren';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.element('browser-search').value, '');
  assert.ok(b.run('state.visibleItems.length') >= 1);
});

test('phase 4 (3): both direct and descendant matches clear search', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'alpha';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Alpha")');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.element('browser-search').value, '');
  assert.equal(b.run('state.visibleItems.map(x => x.name).sort().join(",")'), 'Alpha Sub,Beta Sub');
});

test('phase 4 (4): multiple matching descendants remain visible', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sun';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state.searchQuery'), 'sun');
  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero/Faction")');
  assert.equal(b.run('state.searchQuery'), 'sun');
  assert.equal(b.run('state.visibleItems.map(x => x.name).sort().join(",")'), 'Sunbringer,Sunglow');
});

test('phase 4 (5): multi-level nested search drill-down preserves until matching leaf folder', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sunbringer';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');

  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero/Faction")');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'Sunbringer');

  // Opening the matching folder itself clears the search
  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero/Faction/Sunbringer")');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.element('browser-search').value, '');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), '1.png');
});

test('phase 4 (6 & 7): case-insensitive matching, Unicode, surrounding spaces, and raw query preservation', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = '  ÜÑÎÇØDÉ  ';
  b.run('applyControls({ syncHistory: true })');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'Unicode Series');

  b.run('openFolderByPath("Render 2.0/Unicode Series")');
  assert.equal(b.run('state.searchQuery'), '  ÜÑÎÇØDÉ  ');
  assert.equal(b.element('browser-search').value, '  ÜÑÎÇØDÉ  ');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'Üñîçødé Hero');

  // Clicking matching Unicode folder clears raw query
  b.run('openFolderByPath("Render 2.0/Unicode Series/Üñîçødé Hero")');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.element('browser-search').value, '');
});

test('phase 4 (8): image filename descendant matches preserve search through folders', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'special_boss_render';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Image Match Series")');
  assert.equal(b.run('state.searchQuery'), 'special_boss_render');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'CharY');

  b.run('openFolderByPath("Render 2.0/Image Match Series/CharY")');
  assert.equal(b.run('state.searchQuery'), 'special_boss_render');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'special_boss_render.png');
});

test('phase 4 (9): unrelated programmatic folder navigation clears search', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sunbringer';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Unrelated")');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.element('browser-search').value, '');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'CharU');
});

test('phase 4 (10): Home navigation does not inherit stale search', () => {
  const b = phase4Browser();
  b.run('state.searchQuery = "sunbringer"');
  b.element('browser-search').value = 'sunbringer';
  assert.equal(b.run('state.view'), 'home');

  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state.searchQuery'), '');
  assert.equal(b.element('browser-search').value, '');
});

test('phase 4 (11): zero-result search and manual search clearing in child folder', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sun';
  b.run('applyControls({ syncHistory: true })');
  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state.searchQuery'), 'sun');

  b.element('browser-search').value = 'no_such_match';
  b.run('applyControls({ syncHistory: true })');
  assert.equal(b.run('state.visibleItems.length'), 0);

  b.element('browser-search').value = '';
  b.run('applyControls({ syncHistory: true })');
  assert.equal(b.run('state.visibleItems.map(x => x.name).sort().join(",")'), 'Anby Demara,Faction');
  assert.equal(b.history.state.search, '');

  // Parent still has "sun"
  b.history.back();
  assert.equal(b.run('state.searchQuery'), 'sun');
});

test('phase 4 (12, 13 & 14): in-app Back, browser Back/Forward, and independent per-entry search/sort restoration', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sunbringer';
  b.element('browser-sort').value = 'az';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.sortBy'), 'newest');

  b.element('browser-sort').value = 'za';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero/Faction")');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.sortBy'), 'newest');

  // In-app Back -> Zenless Zone Zero (sunbringer + za)
  b.run('goBack()');
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Zenless Zone Zero');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.sortBy'), 'za');

  // Browser Back -> Browse All (sunbringer + az)
  b.history.back();
  assert.equal(b.run('state.currentPath'), 'Render 2.0');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.sortBy'), 'az');

  // Browser Forward -> Zenless Zone Zero (sunbringer + za)
  b.history.forward();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Zenless Zone Zero');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.sortBy'), 'za');

  // Browser Forward -> Faction (sunbringer + newest)
  b.history.forward();
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Zenless Zone Zero/Faction');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.sortBy'), 'newest');
});

test('phase 4 (15): reload restoration preserves carried search query and sort', async () => {
  const catalog = phase4SyntheticCatalog();
  const first = phase4Browser({ catalog });
  first.run('browseAllFolders()');
  first.element('browser-search').value = 'sunbringer';
  first.element('browser-sort').value = 'az';
  first.run('applyControls({ syncHistory: true })');
  first.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  const persisted = JSON.parse(JSON.stringify(first.history.state));

  const second = browser({ initialState: persisted, catalog });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(second.run('state.currentPath'), 'Render 2.0/Zenless Zone Zero');
  assert.equal(second.run('state.searchQuery'), 'sunbringer');
  assert.equal(second.element('browser-search').value, 'sunbringer');
  assert.equal(second.run('state.visibleItems.map(x => x.name).join(",")'), 'Faction');
});

test('phase 4 (16): modal opening and restoration using genuinely filtered image results', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'special_boss_render';
  b.run('applyControls({ syncHistory: true })');

  b.run('openFolderByPath("Render 2.0/Image Match Series")');
  b.run('openFolderByPath("Render 2.0/Image Match Series/CharY")');
  assert.equal(b.run('state.visibleItems.length'), 1);

  b.run('openCurrent("Render 2.0/Image Match Series/CharY/special_boss_render.png")');
  assert.equal(modalShown(b), true);
  assert.equal(b.run('state.gallery.length'), 1);
  assert.equal(b.run('state.gallery[0].name'), 'special_boss_render.png');

  b.history.back();
  assert.equal(modalShown(b), false);
  assert.equal(b.run('state.searchQuery'), 'special_boss_render');

  b.history.forward();
  assert.equal(modalShown(b), true);
  assert.equal(b.run('state.gallery.length'), 1);
  assert.equal(b.run('state.gallery[0].name'), 'special_boss_render.png');
});

test('phase 4 (17): deferred navigation during pending history traversal computes search continuity after settling', () => {
  const b = phase4Browser({ asyncHistory: true });
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sunbringer';
  b.run('applyControls({ syncHistory: true })');
  b.run('openFolderByPath("Render 2.0/Unrelated")');
  assert.equal(b.run('state.searchQuery'), '');

  // Go back to Browse All (which has "sunbringer"), and while traversal is pending, drill into Zenless Zone Zero
  b.run('goBack()');
  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state._deferred.length'), 1);

  b.flushHistory();
  assert.equal(b.run('state._pendingBack'), 0);
  assert.equal(b.run('state._deferred.length'), 0);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Zenless Zone Zero');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'Faction');
});

test('phase 4 (18): no regression to Phase 3.3 timeout fallback with search continuity', () => {
  const b = phase4Browser();
  b.run('browseAllFolders()');
  b.element('browser-search').value = 'sunbringer';
  b.run('applyControls({ syncHistory: true })');
  b.run('openFolderByPath("Render 2.0/Unrelated")');
  assert.equal(b.run('state.searchQuery'), '');

  // Drop popstate on goBack() to trigger Phase 3.3 timeout fallback, queue deferred drill-down
  b.dropNextBack(1);
  b.run('goBack()');
  b.run('openFolderByPath("Render 2.0/Zenless Zone Zero")');
  assert.equal(b.run('state._pendingBack'), 1);
  assert.equal(b.run('state._deferred.length'), 1);

  b.flushTimers();
  assert.equal(b.run('state._pendingBack'), 0);
  assert.equal(b.run('state._deferred.length'), 0);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Zenless Zone Zero');
  assert.equal(b.run('state.searchQuery'), 'sunbringer');
  assert.equal(b.run('state.visibleItems.map(x => x.name).join(",")'), 'Faction');
});

// ---------------------------------------------------------------------------
// Phase 5A: Shared Card Rendering, DOM Delegation & Card Image Fallbacks
// ---------------------------------------------------------------------------
test('phase 5A: shared renderFolderCard() and renderImageCard() emit data-* attributes without inline onclick/onerror', () => {
  const b = loadedBrowser();
  b.run('renderRecent()');
  const recentImgsHtml = b.element('recent-images').innerHTML;
  const recentFoldersHtml = b.element('recent-folders').innerHTML;

  assert.doesNotMatch(recentImgsHtml, /\bonclick=/i);
  assert.doesNotMatch(recentImgsHtml, /\bonerror=/i);
  assert.doesNotMatch(recentFoldersHtml, /\bonclick=/i);
  assert.doesNotMatch(recentFoldersHtml, /\bonerror=/i);
  assert.match(recentImgsHtml, /data-action="open-recent"/);
  assert.match(recentFoldersHtml, /data-action="open-folder"/);

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren")');
  const folderHtml = b.element('folder-content').innerHTML;
  assert.doesNotMatch(folderHtml, /\bonclick=/i);
  assert.doesNotMatch(folderHtml, /\bonerror=/i);
  assert.match(folderHtml, /data-action="open-folder"/);

  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  const leafHtml = b.element('folder-content').innerHTML;
  assert.doesNotMatch(leafHtml, /\bonclick=/i);
  assert.match(leafHtml, /data-action="open-image"/);
});

test('phase 5A: special-character paths are escaped safely in data-path attributes', () => {
  const b = browser();
  b.run(`state.data = { repository: { rawBase: 'https://example.com/' } };`);
  const specialFolder = {
    name: 'A & B "Quoted" \'Single\' Üñî',
    path: 'Render 2.0/A & B "Quoted" \'Single\' Üñî',
    cover: 'Render 2.0/A & B "Quoted" \'Single\' Üñî/1.png',
    imageCount: 3
  };
  const folderCard = b.run(`renderFolderCard({
    name: ${JSON.stringify(specialFolder.name)},
    path: ${JSON.stringify(specialFolder.path)},
    cover: ${JSON.stringify(specialFolder.cover)},
    imageCount: 3,
    badgeHtml: ""
  })`);
  assert.match(folderCard, /data-path="Render 2\.0\/A &amp; B &quot;Quoted&quot; &#039;Single&#039; Üñî"/);

  const imageCard = b.run(`renderImageCard({
    name: 'Img "1" & <2>',
    path: 'Render 2.0/Series/Img "1" & <2>.png',
    subtitleHtml: 'Image',
    action: 'open-image'
  })`);
  assert.match(imageCard, /data-path="Render 2\.0\/Series\/Img &quot;1&quot; &amp; &lt;2&gt;\.png"/);
});

test('phase 5A: handleCardClick() dispatches open-folder, open-recent, and open-image without duplicate history', () => {
  const b = loadedBrowser();
  const initialLen = b.history.length;

  // 1. Delegated open-folder
  b.run(`handleCardClick({
    target: {
      closest: () => ({ dataset: { action: 'open-folder', path: 'Render 2.0/Sousou No Frieren' } })
    }
  })`);
  assert.equal(b.run('state.currentPath'), 'Render 2.0/Sousou No Frieren');
  assert.equal(b.history.length, initialLen + 1);

  // 2. Delegated open-image
  b.run('openFolderByPath("Render 2.0/Sousou No Frieren/Frieren")');
  const firstImgPath = b.run('state.visibleItems.find(x => x.type === "image").path');
  b.run(`handleCardClick({
    target: {
      closest: () => ({ dataset: { action: 'open-image', path: ${JSON.stringify(firstImgPath)} } })
    }
  })`);
  assert.equal(modalShown(b), true);
  assert.equal(b.run('state.gallery[state.gi].path'), firstImgPath);
  b.run('closeModal()');
  assert.equal(modalShown(b), false);

  // 3. Delegated open-recent
  b.run('showHome()');
  b.run(`handleCardClick({
    target: {
      closest: () => ({ dataset: { action: 'open-recent', index: '0' } })
    }
  })`);
  assert.equal(modalShown(b), true);
  assert.equal(b.run('state.gallerySource'), 'recent');
  assert.equal(b.run('state.gi'), 0);
});

test('phase 5A: handleCardImageError() falls back to icons for folder covers and image cards without affecting modal #fullImage', () => {
  const b = loadedBrowser();

  // Folder cover error
  const coverBox = { innerHTML: '<img>' };
  b.run(`(() => {
    const box = { innerHTML: '<img>' };
    handleCardImageError({
      target: {
        tagName: 'IMG',
        id: '',
        closest: sel => sel === '.folder-cover' ? box : null
      }
    });
    state._testCoverHtml = box.innerHTML;
  })()`);
  assert.match(b.run('state._testCoverHtml'), /fa-folder/);

  // Image card error
  b.run(`(() => {
    const box = { innerHTML: '<img>' };
    handleCardImageError({
      target: {
        tagName: 'IMG',
        id: '',
        closest: sel => sel === '.img-box' ? box : null
      }
    });
    state._testImgHtml = box.innerHTML;
  })()`);
  assert.match(b.run('state._testImgHtml'), /fa-image/);

  // Unrelated / modal image error is ignored by handleCardImageError
  b.run(`(() => {
    const modalBox = { innerHTML: 'keep' };
    handleCardImageError({
      target: {
        tagName: 'IMG',
        id: 'fullImage',
        closest: () => null
      }
    });
    state._testModalUntouched = modalBox.innerHTML;
  })()`);
  assert.equal(b.run('state._testModalUntouched'), 'keep');
});

// ---------------------------------------------------------------------------
// Phase 5B: Modal Accessibility, Background Inertness & Focus Safety
// ---------------------------------------------------------------------------
function phase5bModalBrowser() {
  const docListeners = new Map();
  const makeEl = (id, opts = {}) => {
    const classSet = new Set(opts.classes || []);
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const el = {
      id,
      tagName: opts.tagName || 'DIV',
      value: '',
      innerHTML: '',
      src: '',
      href: opts.href || '',
      textContent: '',
      alt: '',
      inert: Boolean(opts.inert),
      disabled: Boolean(opts.disabled),
      hidden: Boolean(opts.hidden),
      isConnected: opts.isConnected !== false,
      parentElement: null,
      children: [],
      style: { display: opts.display || 'block', visibility: opts.visibility || 'visible' },
      classList: {
        add(cls) { classSet.add(cls); },
        remove(cls) { classSet.delete(cls); },
        contains(cls) { return classSet.has(cls); }
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k) || (k === 'disabled' && el.disabled); },
      closest(sel) {
        for (let cur = el; cur; cur = cur.parentElement) {
          if (sel === '[inert]' && cur.inert) return cur;
          if (sel === '[hidden]' && cur.hidden) return cur;
        }
        return null;
      },
      contains(target) {
        if (!target) return false;
        for (let cur = target; cur; cur = cur.parentElement) {
          if (cur === el) return true;
        }
        return false;
      },
      getClientRects() {
        if (el.hidden || el.style.display === 'none') return [];
        for (let cur = el.parentElement; cur; cur = cur.parentElement) {
          if (cur.hidden || cur.style.display === 'none') return [];
        }
        return [{ width: 10, height: 10 }];
      },
      querySelectorAll(sel) {
        if (el === modal && sel.includes('a[href]')) return [closeBtn, prevBtn, nextBtn, downloadLink];
        return [];
      },
      addEventListener() {},
      focus() {
        if (opts.onFocus) opts.onFocus(el);
        for (let cur = el; cur; cur = cur.parentElement) {
          if (cur.inert) return;
        }
        if (el.disabled || el.hidden || el.isConnected === false) return;
        doc.activeElement = el;
      }
    };
    return el;
  };

  const banner = makeEl('banner');
  const header = makeEl('header');
  const main = makeEl('main');
  const homeView = makeEl('home-view', { tagName: 'SECTION', attrs: { tabindex: '-1' } });
  const browseBtn = makeEl('browse-btn', { tagName: 'BUTTON' });
  homeView.children = [browseBtn];
  browseBtn.parentElement = homeView;

  const folderView = makeEl('folder-view', { tagName: 'SECTION', attrs: { tabindex: '-1' }, display: 'none' });
  const backBtn = makeEl('back-btn', { tagName: 'BUTTON' });
  const triggerCard = makeEl('trigger-card', { tagName: 'ARTICLE', attrs: { role: 'button', tabindex: '0' } });
  folderView.children = [backBtn, triggerCard];
  backBtn.parentElement = folderView;
  triggerCard.parentElement = folderView;

  homeView.parentElement = main;
  folderView.parentElement = main;
  main.children = [homeView, folderView];

  const modal = makeEl('modal', { attrs: { tabindex: '-1' } });
  const closeBtn = makeEl('close-btn', { tagName: 'BUTTON' });
  const prevBtn = makeEl('prev', { tagName: 'BUTTON' });
  const nextBtn = makeEl('next', { tagName: 'BUTTON' });
  const downloadLink = makeEl('download-original', { tagName: 'A', href: 'https://example.com/1.png' });
  const fullImage = makeEl('fullImage', { tagName: 'IMG' });
  const caption = makeEl('caption');
  const previewStatus = makeEl('preview-status');
  for (const child of [closeBtn, prevBtn, nextBtn, downloadLink, fullImage, caption, previewStatus]) {
    child.parentElement = modal;
  }
  modal.children = [closeBtn, prevBtn, nextBtn, downloadLink, fullImage, caption, previewStatus];

  const footer = makeEl('footer', { inert: true }); // pre-existing inert state
  const scriptEl = makeEl('app-script', { tagName: 'SCRIPT' });
  const body = { style: {}, children: [banner, header, main, modal, footer, scriptEl] };
  for (const child of body.children) child.parentElement = body;

  const byId = new Map([
    ['home-view', homeView], ['folder-view', folderView], ['modal', modal],
    ['prev', prevBtn], ['next', nextBtn], ['download-original', downloadLink],
    ['fullImage', fullImage], ['caption', caption], ['preview-status', previewStatus],
    ['browser-search', makeEl('browser-search')], ['browser-sort', makeEl('browser-sort')],
    ['folder-title', makeEl('folder-title')], ['folder-content', makeEl('folder-content')],
    ['recent-images', makeEl('recent-images')], ['recent-folders', makeEl('recent-folders')]
  ]);

  const doc = {
    body,
    activeElement: triggerCard,
    getElementById: id => byId.get(id) || makeEl(id),
    querySelector: sel => {
      if (sel === '.close') return closeBtn;
      if (sel === '#folder-view .back-btn') return backBtn;
      if (sel === '#home-view .browse-btn') return browseBtn;
      if (sel === '#folder-view.active') return folderView.classList.contains('active') ? folderView : null;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(evt, fn) {
      if (!docListeners.has(evt)) docListeners.set(evt, []);
      docListeners.get(evt).push(fn);
    },
    contains: el => Boolean(el && el.isConnected !== false)
  };

  const win = {
    history: {
      state: null,
      replaceState(s) { win.history.state = s; },
      pushState(s) { win.history.state = s; },
      back() {}
    },
    scrollTo() {},
    scrollY: 0,
    location: { href: 'http://localhost/' },
    setTimeout,
    clearTimeout,
    getComputedStyle: el => el.style,
    addEventListener() {}
  };

  const context = vm.createContext({ document: doc, window: win, fetch: () => new Promise(() => {}) });
  const html = fs.readFileSync('index.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  vm.runInContext(`state.data = { repository: { rawBase: 'https://example.com/' }, metadata: {} };`, context);

  return {
    doc,
    els: { banner, header, main, homeView, browseBtn, folderView, backBtn, triggerCard, modal, closeBtn, prevBtn, nextBtn, downloadLink, footer, scriptEl },
    run: code => vm.runInContext(code, context),
    dispatchKeydown(key, shiftKey = false) {
      let prevented = false;
      const evt = { key, shiftKey, target: doc.activeElement, preventDefault() { prevented = true; } };
      for (const fn of (docListeners.get('keydown') || [])) fn(evt);
      return prevented;
    }
  };
}

test('phase 5B: background inertness snapshots prior inert state and restores it before focus restoration', () => {
  const h = phase5bModalBrowser();
  const { banner, header, main, folderView, triggerCard, modal, footer, scriptEl } = h.els;
  folderView.classList.add('active');
  folderView.style.display = 'block';

  let mainInertDuringFocus = null;
  const origFocus = triggerCard.focus;
  triggerCard.focus = function () {
    mainInertDuringFocus = main.inert;
    origFocus.call(this);
  };
  h.doc.activeElement = triggerCard;

  h.run('showGallery([{name:"1.png",path:"1.png",image:"1.png"},{name:"2.png",path:"2.png",image:"2.png"}], 0)');
  assert.equal(banner.inert, true);
  assert.equal(header.inert, true);
  assert.equal(main.inert, true);
  assert.equal(footer.inert, true);
  assert.equal(modal.inert, false);
  assert.equal(scriptEl.inert, false);

  // Switching image while modal is open must not overwrite the snapshot
  h.run('nextImage()');
  h.run('closeModalUI()');

  assert.equal(banner.inert, false);
  assert.equal(header.inert, false);
  assert.equal(main.inert, false);
  assert.equal(footer.inert, true, 'pre-existing inert=true on sibling must be preserved');
  assert.equal(mainInertDuringFocus, false, 'inert must be restored BEFORE focus restoration');
  assert.equal(h.doc.activeElement, triggerCard);
  assert.equal(h.run('state.previousFocus'), null);
});

test('phase 5B: Tab / Shift+Tab focus trap filters enabled/visible controls and handles root/outside focus', () => {
  const h = phase5bModalBrowser();
  const { modal, closeBtn, prevBtn, nextBtn, downloadLink, banner } = h.els;

  // Single-image gallery disables prev and next
  h.run('showGallery([{name:"1.png",path:"1.png",image:"1.png"}], 0)');
  assert.equal(prevBtn.disabled, true);
  assert.equal(nextBtn.disabled, true);
  assert.equal(h.doc.activeElement, closeBtn);

  // Tab on last enabled control (downloadLink) wraps to first (closeBtn)
  h.doc.activeElement = downloadLink;
  assert.equal(h.dispatchKeydown('Tab', false), true);
  assert.equal(h.doc.activeElement, closeBtn);

  // Shift+Tab on first enabled control (closeBtn) wraps to last (downloadLink), skipping disabled prev/next
  assert.equal(h.dispatchKeydown('Tab', true), true);
  assert.equal(h.doc.activeElement, downloadLink);

  // Focus landing on #modal root: Tab -> first, Shift+Tab -> last
  h.doc.activeElement = modal;
  assert.equal(h.dispatchKeydown('Tab', false), true);
  assert.equal(h.doc.activeElement, closeBtn);
  h.doc.activeElement = modal;
  assert.equal(h.dispatchKeydown('Tab', true), true);
  assert.equal(h.doc.activeElement, downloadLink);

  // Focus escaping outside #modal: Tab -> first, Shift+Tab -> last
  h.doc.activeElement = banner;
  assert.equal(h.dispatchKeydown('Tab', false), true);
  assert.equal(h.doc.activeElement, closeBtn);
  h.doc.activeElement = banner;
  assert.equal(h.dispatchKeydown('Tab', true), true);
  assert.equal(h.doc.activeElement, downloadLink);
});

test('phase 5B: closeModalUI falls back to visible focusable control or view container when previousFocus is hidden/removed', () => {
  const h = phase5bModalBrowser();
  const { folderView, backBtn, homeView, browseBtn, triggerCard } = h.els;
  folderView.classList.add('active');
  folderView.style.display = 'block';

  // 1. Removed trigger card in folder view falls back to .back-btn
  h.doc.activeElement = triggerCard;
  h.run('showGallery([{name:"1.png",path:"1.png",image:"1.png"}], 0)');
  triggerCard.isConnected = false;
  h.run('closeModalUI()');
  assert.equal(h.doc.activeElement, backBtn);
  assert.equal(h.run('state.previousFocus'), null);

  // 2. If backBtn is hidden/disabled, falls back to #folder-view (tabindex="-1")
  triggerCard.isConnected = true;
  h.doc.activeElement = triggerCard;
  h.run('showGallery([{name:"1.png",path:"1.png",image:"1.png"}], 0)');
  triggerCard.hidden = true;
  backBtn.disabled = true;
  h.run('closeModalUI()');
  assert.equal(h.doc.activeElement, folderView);
  assert.equal(h.run('state.previousFocus'), null);

  // 3. In home view with hidden trigger, falls back to .browse-btn (or #home-view)
  folderView.classList.remove('active');
  folderView.style.display = 'none';
  const homeCard = { ...triggerCard, parentElement: homeView, hidden: false, isConnected: true, focus() { h.doc.activeElement = this; } };
  h.doc.activeElement = homeCard;
  h.run('showGallery([{name:"1.png",path:"1.png",image:"1.png"}], 0)');
  homeCard.hidden = true;
  h.run('closeModalUI()');
  assert.equal(h.doc.activeElement, browseBtn);
  assert.equal(h.run('state.previousFocus'), null);
});

// ---------------------------------------------------------------------------
// Phase 5C: Modal Lifecycle, Request-Bound Image Loading & Race Safety
// ---------------------------------------------------------------------------
function phase5cModalBrowser() {
  const loaders = [];
  let nextTimerId = 1;
  const timers = new Map();
  const elements = new Map();
  const getEl = id => {
    if (!elements.has(id)) {
      const classSet = new Set();
      elements.set(id, {
        id,
        value: '',
        innerHTML: '',
        textContent: '',
        src: '',
        href: '',
        alt: '',
        disabled: false,
        style: {},
        focus() {},
        classList: {
          add(cls) { classSet.add(cls); },
          remove(cls) { classSet.delete(cls); },
          contains(cls) { return classSet.has(cls); }
        },
        addEventListener() {}
      });
    }
    return elements.get(id);
  };

  class MockImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this._src = '';
      this.savedOnload = null;
      this.savedOnerror = null;
      loaders.push(this);
    }
    set src(val) {
      this._src = val;
      if (val) {
        this.savedOnload = this.onload;
        this.savedOnerror = this.onerror;
      }
    }
    get src() { return this._src; }
  }

  const win = {
    history: { state: null, replaceState(s) { win.history.state = s; }, pushState(s) { win.history.state = s; }, back() {} },
    scrollTo() {},
    scrollY: 0,
    location: { href: 'http://localhost/' },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { id, fn, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {}
  };

  const context = vm.createContext({
    Image: MockImage,
    document: {
      getElementById: getEl,
      querySelector: getEl,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { style: {} },
      activeElement: null,
      contains: () => true
    },
    window: win,
    fetch: () => new Promise(() => {})
  });
  const html = fs.readFileSync('index.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  vm.runInContext(`state.data = { repository: { rawBase: 'https://example.com/' }, metadata: {} };`, context);

  return {
    loaders,
    timers,
    el: getEl,
    run: code => vm.runInContext(code, context),
    fireSlowTimers() {
      for (const t of [...timers.values()]) {
        if (t.delay >= 6000) {
          timers.delete(t.id);
          t.fn();
        }
      }
    }
  };
}

test('phase 5C: out-of-order onload/onerror and rapid next/prev switching ignore stale callbacks', () => {
  const b = phase5cModalBrowser();
  const gallery = [
    { name: '1.png', path: 'a/1.png', image: 'https://img.test/1.png' },
    { name: '2.png', path: 'a/2.png', image: 'https://img.test/2.png' },
    { name: '3.png', path: 'a/3.png', image: 'https://img.test/3.png' }
  ];
  b.run(`showGallery(${JSON.stringify(gallery)}, 0)`);
  assert.equal(b.loaders.length, 1);
  const loader1 = b.loaders[0];
  const seq1 = b.run('state._galleryLoadSeq');

  // Rapidly switch to image 2, then image 3 before image 1 finishes
  b.run('nextImage()');
  assert.equal(loader1.onload, null, 'previous loader onload must be detached');
  assert.equal(loader1.onerror, null, 'previous loader onerror must be detached');
  const loader2 = b.loaders[1];

  b.run('nextImage()');
  assert.equal(loader2.onload, null, 'second loader onload must be detached');
  assert.equal(loader2.onerror, null, 'second loader onerror must be detached');
  const loader3 = b.loaders[2];
  assert.ok(b.run('state._galleryLoadSeq') > seq1);

  // Simulate stale out-of-order callbacks arriving from loader1 (onload) and loader2 (onerror)
  loader1.savedOnload();
  loader2.savedOnerror();
  assert.equal(b.el('fullImage').src, '', 'stale onload must not overwrite #fullImage');
  assert.equal(b.el('preview-status').textContent, 'Memuat preview…', 'stale onerror must not overwrite status');

  // Active loader3 completes
  loader3.savedOnload();
  assert.equal(b.el('fullImage').src, 'https://img.test/3.png');
  assert.equal(b.el('preview-status').textContent, '');
  assert.equal(b.timers.size, 0, 'slow-load timer must be cleared after active load completes');
});

test('phase 5C: close-then-reopen invalidates prior in-flight load and detaches handlers before clearing src', () => {
  const b = phase5cModalBrowser();
  const gallery = [
    { name: '1.png', path: 'a/1.png', image: 'https://img.test/1.png' },
    { name: '2.png', path: 'a/2.png', image: 'https://img.test/2.png' }
  ];
  b.run(`showGallery(${JSON.stringify(gallery)}, 0)`);
  const loader1 = b.loaders[0];
  assert.equal(b.timers.size, 1);

  // Close while loader1 is still in-flight
  b.run('closeModalUI()');
  assert.equal(loader1.onload, null);
  assert.equal(loader1.onerror, null);
  assert.equal(b.timers.size, 0, 'timer must be cleared on close');
  assert.equal(b.el('preview-status').textContent, '');

  // Reopen on image 2
  b.run(`showGallery(${JSON.stringify(gallery)}, 1)`);
  const loader2 = b.loaders[1];

  // Stale error from pre-close loader1 must not affect reopened modal
  loader1.savedOnerror();
  assert.equal(b.el('preview-status').textContent, 'Memuat preview…');

  // Slow-load timer fires for active loader2
  b.fireSlowTimers();
  assert.match(b.el('preview-status').textContent, /lambat/);

  // Loader2 finishes
  loader2.savedOnload();
  assert.equal(b.el('fullImage').src, 'https://img.test/2.png');
  assert.equal(b.el('preview-status').textContent, '');
});

test('phase 5C: duplicate updateGallery calls for the same active target do not spawn duplicate requests', () => {
  const b = phase5cModalBrowser();
  const gallery = [{ name: '1.png', path: 'a/1.png', image: 'https://img.test/1.png' }];
  b.run(`showGallery(${JSON.stringify(gallery)}, 0)`);
  assert.equal(b.loaders.length, 1);

  // Calling updateGallery() again while in-flight
  b.run('updateGallery()');
  assert.equal(b.loaders.length, 1, 'must not spawn duplicate request while in-flight');

  // Complete load, then call updateGallery() again for same loaded target
  b.loaders[0].savedOnload();
  b.run('updateGallery()');
  assert.equal(b.loaders.length, 1, 'must not re-request already loaded active target');
});

// ---------------------------------------------------------------------------
// Phase 5D: Multi-Resolution Delivery, HD Toggle, Placeholder & Bounded Retry
// ---------------------------------------------------------------------------
test('phase 5D: IMAGE_TIERS and thumb() generate 256px, 420px, 800px, and 1600px WebP URLs', () => {
  const b = phase5cModalBrowser();
  const urls = b.run(`({
    logo: thumb('Render 2.0/logo.png', IMAGE_TIERS.logo.width, IMAGE_TIERS.logo.q),
    card: thumb('Render 2.0/a.png', IMAGE_TIERS.card.width, IMAGE_TIERS.card.q),
    modal: thumb('Render 2.0/a.png', IMAGE_TIERS.modal.width, IMAGE_TIERS.modal.q),
    hd: thumb('Render 2.0/a.png', IMAGE_TIERS.hd.width, IMAGE_TIERS.hd.q)
  })`);
  assert.match(urls.logo, /w=256&q=72&output=webp/);
  assert.match(urls.card, /w=420&q=72&output=webp/);
  assert.match(urls.modal, /w=800&q=78&output=webp/);
  assert.match(urls.hd, /w=1600&q=85&output=webp/);
});

test('phase 5D: modal defaults to 800px, upgrades to 1600px only on toggleModalHD, and resets on next/prev/reopen', () => {
  const b = phase5cModalBrowser();
  b.run(`state.visibleItems = [
    { name: '1.png', type: 'image', path: 'Render 2.0/a/1.png' },
    { name: '2.png', type: 'image', path: 'Render 2.0/a/2.png' }
  ];`);
  b.run(`openCurrent('Render 2.0/a/1.png')`);
  assert.equal(b.loaders.length, 1);
  assert.match(b.loaders[0].src, /w=800&q=78&output=webp/);
  assert.doesNotMatch(b.loaders[0].src, /w=1600/);
  assert.equal(b.run('state.modalHd'), false);

  b.loaders[0].savedOnload();
  assert.match(b.el('fullImage').src, /w=800&q=78&output=webp/);

  // User clicks HD toggle
  b.run('toggleModalHD()');
  assert.equal(b.run('state.modalHd'), true);
  assert.equal(b.loaders.length, 2);
  assert.match(b.loaders[1].src, /w=1600&q=85&output=webp/);
  // Standard 800px image remains visible while 1600px loads
  assert.match(b.el('fullImage').src, /w=800&q=78&output=webp/);
  b.loaders[1].savedOnload();
  assert.match(b.el('fullImage').src, /w=1600&q=85&output=webp/);

  // Switching image resets HD back to 800px
  b.run('nextImage()');
  assert.equal(b.run('state.modalHd'), false);
  assert.equal(b.loaders.length, 3);
  assert.match(b.loaders[2].src, /w=800&q=78&output=webp/);

  // Toggle HD then previousImage() also resets back to 800px
  b.loaders[2].savedOnload();
  b.run('toggleModalHD()');
  assert.equal(b.run('state.modalHd'), true);
  b.run('previousImage()');
  assert.equal(b.run('state.modalHd'), false);
  assert.match(b.loaders.at(-1).src, /w=800&q=78&output=webp/);

  // Toggle HD then close & reopen resets to 800px
  b.run('toggleModalHD()');
  b.run('closeModalUI()');
  assert.equal(b.run('state.modalHd'), false);
  b.run(`openCurrent('Render 2.0/a/1.png')`);
  assert.equal(b.run('state.modalHd'), false);
  assert.match(b.loaders.at(-1).src, /w=800&q=78&output=webp/);
});

test('phase 5D: bounded retry runs at most once and respects Phase 5C sequence cancellation', () => {
  const b = phase5cModalBrowser();
  b.run(`state.visibleItems = [
    { name: '1.png', type: 'image', path: 'Render 2.0/a/1.png' },
    { name: '2.png', type: 'image', path: 'Render 2.0/a/2.png' }
  ];`);
  b.run(`openCurrent('Render 2.0/a/1.png')`);
  assert.equal(b.loaders.length, 1);

  // First attempt fails -> bounded retry spawns 1 new loader
  b.loaders[0].savedOnerror();
  assert.equal(b.loaders.length, 2, 'should retry once on initial error');
  assert.equal(b.el('preview-status').textContent, 'Memuat preview…');

  // Retry succeeds
  b.loaders[1].savedOnload();
  assert.match(b.el('fullImage').src, /w=800/);
  assert.equal(b.el('preview-status').textContent, '');

  // Next image fails twice -> no infinite loop, clean failure state
  b.run('nextImage()');
  const idx = b.loaders.length - 1;
  b.loaders[idx].savedOnerror();
  assert.equal(b.loaders.length, idx + 2);
  b.loaders[idx + 1].savedOnerror();
  assert.equal(b.loaders.length, idx + 2, 'must not retry more than once');
  assert.match(b.el('preview-status').textContent, /gagal dimuat/);
  assert.equal(b.timers.size, 0);
});

// ---------------------------------------------------------------------------
// Phase 6D: Accessible Mobile Drawer, Focus Containment & Scroll Lock Safety
// ---------------------------------------------------------------------------
test('phase 6D: mobile drawer manages inert background, Tab trap, Escape dismissal, and focus restoration', () => {
  const docListeners = new Map();
  const makeEl = (id, opts = {}) => {
    const classSet = new Set(opts.classes || []);
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const el = {
      id,
      tagName: opts.tagName || 'DIV',
      value: '',
      innerHTML: '',
      textContent: '',
      src: '',
      href: opts.href || '',
      inert: Boolean(opts.inert),
      disabled: false,
      hidden: false,
      isConnected: true,
      parentElement: null,
      style: { display: 'block', visibility: 'visible' },
      classList: {
        add(c) { classSet.add(c); },
        remove(c) { classSet.delete(c); },
        toggle(c, force) { const next = typeof force === 'boolean' ? force : !classSet.has(c); next ? classSet.add(c) : classSet.delete(c); return next; },
        contains(c) { return classSet.has(c); }
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
      hasAttribute(k) { return attrs.has(k); },
      closest(sel) {
        for (let cur = el; cur; cur = cur.parentElement) {
          if (sel === '[inert]' && cur.inert) return cur;
          if (sel === '[hidden]' && cur.hidden) return cur;
        }
        return null;
      },
      contains(target) {
        for (let cur = target; cur; cur = cur.parentElement) {
          if (cur === el) return true;
        }
        return false;
      },
      getClientRects() { return [{ width: 20, height: 20 }]; },
      querySelectorAll(sel) {
        if (el === sidebar && sel.includes('a[href]')) return [drawerClose, navHome, navBrowse];
        return [];
      },
      addEventListener() {},
      focus() {
        for (let cur = el; cur; cur = cur.parentElement) { if (cur.inert) return; }
        doc.activeElement = el;
      }
    };
    return el;
  };

  const header = makeEl('app-header');
  const menuToggle = makeEl('menu-toggle', { tagName: 'BUTTON', attrs: { 'aria-expanded': 'false' } });
  menuToggle.parentElement = header;
  const main = makeEl('main-content');
  const footer = makeEl('footer');
  const backdrop = makeEl('sidebar-backdrop');
  const sidebar = makeEl('app-sidebar', { tagName: 'ASIDE', attrs: { tabindex: '-1' } });
  const drawerClose = makeEl('drawer-close', { tagName: 'BUTTON' });
  const navHome = makeEl('nav-home', { tagName: 'BUTTON' });
  const navBrowse = makeEl('nav-browse', { tagName: 'BUTTON' });
  for (const c of [drawerClose, navHome, navBrowse]) c.parentElement = sidebar;

  const modal = makeEl('modal', { attrs: { tabindex: '-1' } });
  const closeBtn = makeEl('modal-close', { tagName: 'BUTTON' });
  const body = { style: { overflow: 'auto' }, children: [header, main, footer, modal] };

  const byId = new Map([
    ['app-sidebar', sidebar], ['sidebar-backdrop', backdrop], ['menu-toggle', menuToggle],
    ['drawer-close', drawerClose], ['nav-home', navHome], ['nav-browse', navBrowse],
    ['modal', modal], ['fullImage', makeEl('fullImage')], ['preview-status', makeEl('preview-status')],
    ['caption', makeEl('caption')], ['download-original', makeEl('download-original')],
    ['prev', makeEl('prev')], ['next', makeEl('next')], ['browser-search', makeEl('browser-search')],
    ['browser-sort', makeEl('browser-sort')], ['home-view', makeEl('home-view')], ['folder-view', makeEl('folder-view')]
  ]);

  const doc = {
    body,
    activeElement: menuToggle,
    getElementById: id => byId.get(id) || makeEl(id),
    querySelector: sel => {
      if (sel === '.app-header') return header;
      if (sel === 'main.main-content') return main;
      if (sel === 'footer') return footer;
      if (sel === '.close') return closeBtn;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(evt, fn) {
      if (!docListeners.has(evt)) docListeners.set(evt, []);
      docListeners.get(evt).push(fn);
    },
    contains: () => true
  };
  const win = {
    history: { state: null, replaceState(s) { win.history.state = s; }, pushState(s) { win.history.state = s; }, back() {} },
    scrollTo() {},
    scrollY: 0,
    location: { href: 'http://localhost/' },
    setTimeout,
    clearTimeout,
    getComputedStyle: el => el.style,
    addEventListener() {}
  };

  const context = vm.createContext({ document: doc, window: win, fetch: () => new Promise(() => {}) });
  const html = fs.readFileSync('index.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  vm.runInContext(`state.data = { repository: { rawBase: 'https://example.com/' }, metadata: {} };`, context);

  const keydown = (key, shiftKey = false) => {
    let prevented = false;
    const evt = { key, shiftKey, target: doc.activeElement, preventDefault() { prevented = true; } };
    for (const fn of (docListeners.get('keydown') || [])) fn(evt);
    return prevented;
  };

  // 1. Open drawer: inert background, dialog role, focus moves to #drawer-close, scroll locked
  vm.runInContext('toggleMobileNav(true)', context);
  assert.equal(sidebar.classList.contains('open'), true);
  assert.equal(backdrop.classList.contains('open'), true);
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(sidebar.getAttribute('role'), 'dialog');
  assert.equal(sidebar.getAttribute('aria-modal'), 'true');
  assert.equal(header.inert, true);
  assert.equal(main.inert, true);
  assert.equal(footer.inert, true);
  assert.equal(body.style.overflow, 'hidden');
  assert.equal(doc.activeElement, drawerClose);

  // 2. Tab / Shift+Tab wraps inside drawer
  doc.activeElement = navBrowse;
  assert.equal(keydown('Tab', false), true);
  assert.equal(doc.activeElement, drawerClose);
  assert.equal(keydown('Tab', true), true);
  assert.equal(doc.activeElement, navBrowse);

  // 3. Escape closes drawer, restores inert, restores previous overflow ('auto'), and returns focus to #menu-toggle
  assert.equal(keydown('Escape'), true);
  assert.equal(sidebar.classList.contains('open'), false);
  assert.equal(menuToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(sidebar.getAttribute('role'), 'navigation');
  assert.equal(header.inert, false);
  assert.equal(main.inert, false);
  assert.equal(footer.inert, false);
  assert.equal(body.style.overflow, 'auto', 'must restore prior body overflow instead of hard-clearing');
  assert.equal(doc.activeElement, menuToggle);

  // 4. Opening gallery modal while drawer is active cleanly closes drawer and keeps scroll locked until modal closes
  vm.runInContext('toggleMobileNav(true)', context);
  assert.equal(sidebar.classList.contains('open'), true);
  vm.runInContext('showGallery([{name:"1.png",path:"a/1.png",image:"1.png"}], 0)', context);
  assert.equal(sidebar.classList.contains('open'), false, 'drawer must close when modal opens');
  assert.equal(body.style.overflow, 'hidden', 'modal must keep scroll locked');
  vm.runInContext('closeModalUI()', context);
  assert.equal(body.style.overflow, 'auto', 'modal close must restore original pre-lock overflow');
});
