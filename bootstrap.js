/* eslint-disable no-undef */
// Metadata Mender — bootstrap entry point (Zotero 7+).
// Bootstrapped plugins run in a sandbox that already provides `Zotero`,
// `Services`, and `Components` as globals. We don't import them.

var MetadataMender;
var chromeHandle;
var l10nSourceRegistered = false;
const L10N_SOURCE_NAME = "metadata-mender";

function log(msg) {
  Zotero.debug("Metadata Mender: " + msg);
}

// ---- Lifecycle hooks ----

async function install() {
  log("installed");
}

async function startup({ id, version, rootURI }) {
  log("starting up v" + version);

  // Wait until Zotero is fully ready before touching UI or schema.
  await Zotero.initializationPromise;

  // Register a chrome:// mapping so our preferences XHTML and assets resolve.
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "metadata-mender", rootURI + "content/"],
    ["locale", "metadata-mender", "en-US", rootURI + "locale/en-US/"],
  ]);

  // Register the FTL as a Fluent file source so `MozXULElement.insertFTLIfNeeded`
  // and `document.l10n.formatValue` can resolve `metadata-mender.ftl`.
  try {
    const source = new L10nFileSource(
      L10N_SOURCE_NAME,
      "app",
      ["en-US"],
      "chrome://metadata-mender/locale/{locale}/"
    );
    L10nRegistry.getInstance().registerSources([source]);
    l10nSourceRegistered = true;
  } catch (e) {
    log("L10n source registration failed (UI will use English fallbacks): " + e);
  }

  // Load the main module into the plugin sandbox.
  Services.scriptloader.loadSubScript(
    rootURI + "content/metadata-mender.js",
    { Zotero, rootURI }
  );

  MetadataMender = Zotero.MetadataMender;
  MetadataMender.init({ id, version, rootURI });
  MetadataMender.addToAllWindows();

  Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "content/preferences.xhtml",
    label: "Metadata Mender",
    image: rootURI + "content/icons/icon@48.png",
  });
}

function shutdown() {
  log("shutting down");
  if (MetadataMender) {
    MetadataMender.removeFromAllWindows();
    MetadataMender.shutdown();
    MetadataMender = undefined;
    delete Zotero.MetadataMender;
  }
  if (l10nSourceRegistered) {
    try {
      L10nRegistry.getInstance().removeSources([L10N_SOURCE_NAME]);
    } catch (e) {
      log("L10n source removal failed: " + e);
    }
    l10nSourceRegistered = false;
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = undefined;
  }
}

function uninstall() {
  log("uninstalled");
}

// ---- Window hooks ---- Zotero calls these per main window.

function onMainWindowLoad({ window }) {
  if (MetadataMender) {
    MetadataMender.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (MetadataMender) {
    MetadataMender.removeFromWindow(window);
  }
}
