import Port = chrome.runtime.Port;
import Tab = chrome.tabs.Tab;

function inject(tab: Tab | null) {
  if (tab == null || tab.id == null) {
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ["content.js"],
  });
}

chrome.action.onClicked.addListener(inject);

function connectPorts(lhs: Port, rhs: Port) {
  function oneWay(from: Port, to: Port) {
    from.onMessage.addListener((message) => {
      to.postMessage(message);
    });
    from.onDisconnect.addListener(() => {
      to.disconnect();
    });
  }

  oneWay(lhs, rhs);
  oneWay(rhs, lhs);
}

const editsInTabs: Set<number> = new Set();

chrome.runtime.onConnect.addListener((contentPort: Port) => {
  console.assert(contentPort.name === "content");
  if (contentPort.sender == undefined) {
    contentPort.disconnect();
    throw "No sender";
  }
  const tab = contentPort.sender.tab;
  if (tab == undefined) {
    contentPort.disconnect();
    throw "No tab";
  }
  const tabId = tab.id;
  if (tabId == null) {
    contentPort.disconnect();
    throw "No tab id";
  }

  if (editsInTabs.has(tabId)) {
    contentPort.disconnect();
  }

  const nativeHost = "com.mbid.vim.compose";
  const nativePort = chrome.runtime.connectNative(nativeHost);

  editsInTabs.add(tabId);
  contentPort.onDisconnect.addListener(() => {
    editsInTabs.delete(tabId);
  });
  nativePort.onDisconnect.addListener(() => {
    editsInTabs.delete(tabId);
  });

  connectPorts(contentPort, nativePort);
});
