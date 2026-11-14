const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  const sources = [], removed = [], logs = [];
  const registry = {registerSources(value) { sources.push(...value); }, removeSources(value) { removed.push(...value); }};
  class Source { constructor(...args) { this.args = args; } }
  class Registry { static getInstance() { return registry; } }
  const context = {Zotero:{debug: message => logs.push(message)}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../bootstrap.js'),'utf8'),context);
  context.MetadataMender={addToWindow(){},removeFromAllWindows(){},shutdown(){}};
  return {context, window:{L10nFileSource:Source,L10nRegistry:Registry}, sources, removed, logs};
}

test('window Fluent constructors register once across repeated and multiple windows', () => {
  const f=setup();
  f.context.registerLocalization(f.window);
  f.context.onMainWindowLoad({window:f.window});
  f.context.onMainWindowLoad({window:{...f.window}});
  assert.equal(f.sources.length,1);
  assert.deepEqual(Array.from(f.sources[0].args[2]),['en-US']);
  assert.equal(f.sources[0].args[3],'chrome://metadata-mender/locale/{locale}/');
  assert.equal(f.logs.length,0);
  f.context.shutdown();
  assert.deepEqual(f.removed,['metadata-mender']);
  f.context.shutdown();
  assert.equal(f.removed.length,1);
});

test('missing-window fallback retries registration when a real window arrives', () => {
  const f=setup();
  f.context.registerLocalization(null);
  f.context.onMainWindowLoad({window:{}});
  assert.equal(f.sources.length,0);
  assert.equal(f.logs.filter(x=>x.includes('English fallbacks')).length,2);
  f.context.onMainWindowLoad({window:f.window});
  assert.equal(f.sources.length,1);
  f.context.shutdown();
  f.context.onMainWindowLoad({window:f.window});
  assert.equal(f.sources.length,1, "late callbacks after shutdown do not register a source");
  f.context.MetadataMender={addToWindow(){},removeFromAllWindows(){},shutdown(){}};
  f.context.onMainWindowLoad({window:f.window});
  assert.equal(f.sources.length,2);
});

test('unavailable Fluent API retains explicit fallback without false registration', () => {
  const f=setup();
  f.context.registerLocalization({L10nFileSource: class { constructor() { throw Error('unavailable'); } },L10nRegistry:f.window.L10nRegistry});
  assert.equal(f.sources.length,0);
  assert.match(f.logs[0],/English fallbacks.*unavailable/);
  f.context.shutdown();
  assert.equal(f.removed.length,0);
});
