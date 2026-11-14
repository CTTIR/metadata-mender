async function runFixture(Zotero, IOUtils, root, checks) {
  const ok = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  const item = async (title, doi) => {
    const value = new Zotero.Item('journalArticle');
    value.libraryID = Zotero.Libraries.userLibraryID;
    value.setField('title', title);
    if (doi) value.setField('DOI', doi);
    await value.saveTx();
    return value;
  };
  const stamp = Date.now();
    const M = Zotero.MetadataMender;
    const window = Zotero.getMainWindow();
    const registry = window.L10nRegistry.getInstance();
    if (typeof registry.hasSource !== 'function') throw new Error('Registry inspection unavailable: '+Object.getOwnPropertyNames(Object.getPrototypeOf(registry)).join(','));
    ok(registry.hasSource('metadata-mender'), 'actual Fluent source registered');
    const localization = new window.Localization(['metadata-mender.ftl'], false);
    ok(await localization.formatValue('mm-prefs-keys-header') === 'API access', 'actual Fluent source resolves preference heading');
    ok(await M._t(window, 'mm-alert-no-selection') === 'No regular items selected.', 'actual window localization resolves plugin message');
    const progress = await localization.formatValue('mm-progress-tick', {done:2,total:3});
    ok(progress.includes('2') && progress.includes('3') && progress.includes('Reconciling'), 'Fluent message interpolation resolves');

    Zotero.Prefs.set(M.PREFS.sourcePriority, 'crossref', true);
    Zotero.Prefs.set(M.PREFS.overwriteMode, 'fill', true);
    const title = 'Synthetic audit reference '+stamp;
    const ref = await item(title, '10.1234/audit'+stamp);
    ref.setCreators([{firstName:'Complete', lastName:'Researcher', creatorType:'author'}]);
    ref.addTag('manual-reviewed');
    ref.setField('extra', 'Synthetic private note');
    await ref.saveTx();
    M._get = async () => { throw new Error('Live provider access forbidden in fixture'); };
    M.fetchCrossref = async () => ({DOI:ref.getField('DOI'),title,volume:'7',creators:[{firstName:'C',lastName:'Researcher',creatorType:'author'}]});
    let result = await M.reconcileItem(ref);
    ok(result.status === 'updated', 'real database reconciliation updated');
    await ref.reload(null, true);
    ok(ref.getField('volume') === '7', 'missing volume persisted');
    ok(ref.getField('title') === title && ref.getCreators()[0].firstName === 'Complete', 'reviewed title and full creator preserved');
    ok(ref.getTags().some(x=>x.tag==='manual-reviewed') && ref.getField('extra').includes('Synthetic private note'), 'manual tag and extra retained');
    M.fetchCrossref = async () => ({DOI:'10.1234/wrong',title,volume:'99'});
    result = await M.reconcileItem(ref);
    ok(result.status === 'error' && ref.getField('volume') === '7', 'wrong provider identifier refuses write');
    M.fetchCrossref = async () => ({DOI:ref.getField('DOI'),title,issue:'8'});
    const save = ref.saveTx;
    ref.saveTx = async () => { throw new Error('Injected synthetic save failure'); };
    let refused = false;
    try { await M.reconcileItem(ref); } catch (e) { refused = /original item was reloaded/.test(String(e)); }
    finally { ref.saveTx = save; }
    ok(refused, 'failed staged update uses actual reload recovery');
    ok(!ref.getField('issue') && !ref.hasChanged(), 'save failure clears staged field and pending edits');

}
function isReady(Zotero) { return Boolean(Zotero.MetadataMender); }
function isStopped(Zotero) { return !Zotero.MetadataMender; }
function checkShutdown(Zotero, checks) { if (!isStopped(Zotero)) throw new Error("Addon namespace survived shutdown"); checks.push("actual addon shutdown removes namespace"); const registry=Zotero.getMainWindow().L10nRegistry.getInstance(); if(registry.hasSource("metadata-mender")) throw new Error("Fluent source survived addon shutdown"); checks.push("actual Fluent source removed on shutdown"); }
