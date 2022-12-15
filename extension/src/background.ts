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

chrome.commands.onCommand.addListener((command: string, tab: Tab | null) => {
  if (command !== "inject-script") {
    return;
  }
  inject(tab);
});

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

chrome.runtime.onConnect.addListener((contentPort: Port) => {
  console.assert(contentPort.name === "content");

  const nativeHost = "com.mbid.vim.compose";
  const nativePort = chrome.runtime.connectNative(nativeHost);

  connectPorts(contentPort, nativePort);
});
