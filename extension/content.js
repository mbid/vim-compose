(function() {
  const el = document.activeElement;
  if (!el.contentEditable) {
    return;
  }

  const port = chrome.runtime.connect({name: "content"});

  port.postMessage({"begin": {initialContent: el.innerText, contentType: "Plain"}});

  port.onMessage.addListener((message) => {
    console.log(`Got message: ${message}`);
    for (const [type, value] of Object.entries(message)) {
      switch (type) {
        case "replaceAll":
          el.innerText = value;
          break;
        default:
          console.error("Invalid message type:", type);
          break;
      }
    }
  });
})();
