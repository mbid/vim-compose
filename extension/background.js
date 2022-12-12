chrome.action.onClicked.addListener((tab) => {
  console.log("action.onClicked");
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js']
  });
});

function connectPorts(lhs, rhs) {
  function oneWay(from, to) {
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

chrome.runtime.onConnect.addListener(function(contentPort) {
  console.assert(contentPort.name === "content");

  const nativeHost = "com.mbid.vim.compose";
  const nativePort = chrome.runtime.connectNative(nativeHost);

  connectPorts(contentPort, nativePort);
});
