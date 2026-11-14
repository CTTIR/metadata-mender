const settings = __SETTINGS__;
function startup() {
  // Do not hold addon startup open while database notifications await the UI.
  setTimeout(() => runFixtureGate().catch(error => Zotero.logError(error)), 0);
}
async function runFixtureGate() {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const evidence = {profile: Services.dirsvc.get('ProfD', Components.interfaces.nsIFile).path,
    data: Zotero.DataDirectory.dir, version: Zotero.version, checks: [], passed: false};
  let addon;
  try {
    if (evidence.profile !== settings.profile || evidence.data !== settings.data) {
      throw new Error('Refusing fixture outside the expected disposable profile/data directory');
    }
    const pane = Zotero.getMainWindow().ZoteroPane;
    const libraryID = Zotero.Libraries.userLibraryID;
    for (let i=0; i<100 && pane.collectionsView.getRowIndexByID('L'+libraryID) === false; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (await pane.collectionsView.selectLibrary(libraryID) !== true) {
      throw new Error('Synthetic library did not become selectable in the native UI');
    }
    await pane.itemsView.waitForLoad();
    const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const file = Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(settings.artifact);
    addon = await AddonManager.installTemporaryAddon(file);
    if (addon.id !== settings.pluginID || !addon.isActive) throw new Error('Expected addon did not activate');
    const scope = {};
    Services.scriptloader.loadSubScript(settings.fixture, scope);
    for (let i=0; i<100 && !scope.isReady(Zotero); i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!scope.isReady(Zotero)) throw new Error('Addon namespace did not become ready');
    evidence.checks.push('actual addon startup ready');
    await scope.runFixture(Zotero, IOUtils, settings.root, evidence.checks);
    await addon.uninstall();
    addon = null;
    for (let i=0; i<100 && !scope.isStopped(Zotero); i++) await new Promise(resolve => setTimeout(resolve, 100));
    await scope.checkShutdown(Zotero, evidence.checks);
    evidence.passed = true;
  } catch (error) {
    evidence.error = String(error);
    evidence.stack = error.stack;
    evidence.additionalErrors = error.additionalErrors || [];
  } finally {
    if (addon) { try { await addon.uninstall(); } catch(error) { evidence.cleanupError = String(error); } }
    await IOUtils.writeUTF8(settings.result + ".tmp", JSON.stringify(evidence, null, 2));
    await IOUtils.move(settings.result + ".tmp", settings.result, {noOverwrite:true});
  }
}
function install() {}
function uninstall() {}
function shutdown() {}
