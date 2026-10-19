const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildCatalog } = require('../scripts/build-catalog.cjs');

function browser() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', focus() {}, classList: { add() {}, remove() {}, contains() { return true; } }, style: {}, addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { getElementById: element, querySelector: element, addEventListener() {}, body: { style: {} } }, window: { scrollTo() {} }, fetch: () => new Promise(() => {}) });
  const html = fs.readFileSync('index.html', 'utf8');
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { element, run: code => vm.runInContext(code, context) };
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
  assert.match(b.element('fullImage').src, /wsrv.nl/);
  assert.match(b.element('fullImage').src, /w=1600/);
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
