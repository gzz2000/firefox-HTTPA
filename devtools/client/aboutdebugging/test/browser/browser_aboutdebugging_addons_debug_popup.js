/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

/* import-globals-from helper-addons.js */
Services.scriptloader.loadSubScript(CHROME_URL_ROOT + "helper-addons.js", this);

// There are shutdown issues for which multiple rejections are left uncaught.
// See bug 1018184 for resolving these issues.
const { PromiseTestUtils } = ChromeUtils.import(
  "resource://testing-common/PromiseTestUtils.jsm"
);
PromiseTestUtils.allowMatchingRejectionsGlobally(/File closed/);

// Avoid test timeouts that can occur while waiting for the "addon-console-works" message.
requestLongerTimeout(2);

const ADDON_ID = "test-devtools-webextension@mozilla.org";
const ADDON_NAME = "test-devtools-webextension";

/**
 * This test file ensures that the webextension addon developer toolbox:
 * - has a frame list menu and the noautohide toolbar toggle button, and they
 *   can be used to switch the current target to the extension popup page.
 */
add_task(async function testWebExtensionsToolboxWebConsole() {
  await enableExtensionDebugging();

  is(
    Services.prefs.getBoolPref("ui.popup.disable_autohide"),
    false,
    "disable_autohide should be initially false"
  );

  const {
    document,
    tab,
    window: aboutDebuggingWindow,
  } = await openAboutDebugging();
  await selectThisFirefoxPage(
    document,
    aboutDebuggingWindow.AboutDebugging.store
  );

  const extension = await installTestAddon(document);

  const onBackgroundFunctionCalled = waitForExtensionTestMessage(
    extension,
    "onBackgroundFunctionCalled"
  );
  const onPopupPageFunctionCalled = waitForExtensionTestMessage(
    extension,
    "onPopupPageFunctionCalled"
  );

  info("Open a toolbox to debug the addon");
  const { devtoolsTab, devtoolsWindow } = await openAboutDevtoolsToolbox(
    document,
    tab,
    aboutDebuggingWindow,
    ADDON_NAME
  );
  const toolbox = getToolbox(devtoolsWindow);
  const webconsole = await toolbox.selectTool("webconsole");

  info("Clicking the menu button to disable autohide");
  await disablePopupAutohide(toolbox);

  info("Check that console messages are evaluated in the background context");
  const consoleWrapper = webconsole.hud.ui.wrapper;
  consoleWrapper.dispatchEvaluateExpression("backgroundFunction()");
  await onBackgroundFunctionCalled;

  // Find the browserAction button that will show the webextension popup.
  const widgetId = ADDON_ID.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const browserActionId = widgetId + "-browser-action";
  const browserActionEl = window.document.getElementById(browserActionId);
  ok(browserActionEl, "Got the browserAction button from the browser UI");

  // Create a promise that will resolve when popup.html appears in the list of
  // frames known by the toolbox.
  const popupFramePromise = new Promise(resolve => {
    const listener = data => {
      if (data.frames.some(({ url }) => url && url.endsWith("popup.html"))) {
        toolbox.target.off("frame-update", listener);
        resolve();
      }
    };
    toolbox.target.on("frame-update", listener);
  });

  info("Show the web extension popup");
  browserActionEl.click();

  info("Wait until popup.html appears in the frames list menu button");
  await popupFramePromise;

  info("Clicking the frame list button");
  const btn = toolbox.doc.getElementById("command-button-frames");
  btn.click();

  const menuList = toolbox.doc.getElementById("toolbox-frame-menu");
  const frames = Array.from(menuList.querySelectorAll(".command"));
  is(frames.length, 2, "Has the expected number of frames");

  const popupFrameBtn = frames
    .filter(frame => {
      return frame.querySelector(".label").textContent.endsWith("popup.html");
    })
    .pop();

  ok(popupFrameBtn, "Extension Popup frame found in the listed frames");

  info("Click on the extension popup frame and wait for `navigate`");
  const waitForNavigated = toolbox.target.once("navigate");
  popupFrameBtn.click();
  await waitForNavigated;

  info("Execute `popupPageFunction()`");
  consoleWrapper.dispatchEvaluateExpression("popupPageFunction()");

  const args = await onPopupPageFunctionCalled;
  ok(true, "Received console message from the popup page function as expected");
  is(args[0], "onPopupPageFunctionCalled", "Got the expected console message");
  is(
    args[1] && args[1].name,
    ADDON_NAME,
    "Got the expected manifest from WebExtension API"
  );

  await closeAboutDevtoolsToolbox(document, devtoolsTab, aboutDebuggingWindow);

  is(
    Services.prefs.getBoolPref("ui.popup.disable_autohide"),
    false,
    "disable_autohide should be reset to false when the toolbox is closed"
  );

  await removeTemporaryExtension(ADDON_NAME, document);
  await removeTab(tab);
});

/**
 * Helper to wait for a specific message on an Extension instance.
 */
function waitForExtensionTestMessage(extension, expectedMessage) {
  return new Promise(done => {
    extension.on("test-message", function testLogListener(evt, ...args) {
      const [message] = args;

      if (message !== expectedMessage) {
        return;
      }

      extension.off("test-message", testLogListener);
      done(args);
    });
  });
}

/**
 * Install the addon used for this test.
 * Returns a Promise that resolve the Extension instance that was just
 * installed.
 */
async function installTestAddon(doc) {
  // Start watching for the extension on the Extension Management before we
  // install it.
  const onExtensionReady = waitForExtension(ADDON_NAME);

  // Install the extension.
  await installTemporaryExtensionFromXPI(
    {
      background: function() {
        const { browser } = this;
        window.backgroundFunction = function() {
          browser.test.sendMessage("onBackgroundFunctionCalled");
        };
      },
      extraProperties: {
        browser_action: {
          default_title: "WebExtension Popup Debugging",
          default_popup: "popup.html",
        },
      },
      files: {
        "popup.html": `<!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <script src="popup.js"></script>
          </head>
          <body>
            Background Page Body Test Content
          </body>
        </html>
      `,
        "popup.js": function() {
          const { browser } = this;
          window.popupPageFunction = function() {
            browser.test.sendMessage(
              "onPopupPageFunctionCalled",
              browser.runtime.getManifest()
            );
          };
        },
      },
      id: ADDON_ID,
      name: ADDON_NAME,
    },
    doc
  );

  // The onExtensionReady promise will resolve the extension instance.
  return onExtensionReady;
}

/**
 * Helper to retrieve the Extension instance.
 */
async function waitForExtension(addonName) {
  const { Management } = ChromeUtils.import(
    "resource://gre/modules/Extension.jsm",
    null
  );

  return new Promise(resolve => {
    Management.on("startup", function listener(event, extension) {
      if (extension.name != addonName) {
        return;
      }

      Management.off("startup", listener);
      resolve(extension);
    });
  });
}

/**
 * Disables the popup autohide feature, which is mandatory to debug webextension
 * popups.
 */
function disablePopupAutohide(toolbox) {
  return new Promise(resolve => {
    toolbox.doc.getElementById("toolbox-meatball-menu-button").click();
    toolbox.doc.addEventListener(
      "popupshown",
      () => {
        const menuItem = toolbox.doc.getElementById(
          "toolbox-meatball-menu-noautohide"
        );
        menuItem.click();
        resolve();
      },
      { once: true }
    );
  });
}
