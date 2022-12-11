function flatten(el) {
  if (!el.parentElement) {
    return;
  }

  while (el.childNodes.length > 0) {
    el.parentElement.insertBefore(el.childNodes[0], el);
  }
  el.remove();
}


function cleanMessage(inputBox) {
  for (const el of inputBox.querySelectorAll('div.gmail_quote')) {
    flatten(el);
  }

  for (const el of inputBox.querySelectorAll('div.gmail_attr')) {
    flatten(el);
  }

  for (const el of inputBox.querySelectorAll('div')) {
    if (el.parentNode) {
      el.parentNode.insertBefore(document.createElement("br"), el.nextSibling);
    }
    flatten(el);
  }

  for (const el of inputBox.querySelectorAll('a[href^="mailto:"]')) {
    flatten(el);
  }
}

function findBlockquoteStyle(inputBox) {
  for (const blockquote of inputBox.querySelectorAll('blockquote')) {
    const style = blockquote.getAttribute('style');
    if (style) {
      return style;
    }
  }

  return null;
}

(function() {
  const el = document.activeElement;
  if (!el.getAttribute('contentEditable') === true) {
    return;
  }
  const blockquoteStyle = findBlockquoteStyle(el);
  cleanMessage(el);
  el.setAttribute("contentEditable", false);

  const port = chrome.runtime.connect({name: "content"});
  var intervalId;

  function exit() {
    port.disconnect();
    clearTimeout(intervalID);
    el.setAttribute("contentEditable", true);
  }

  port.onDisconnect.addListener(exit);

  intervalID = setInterval(() => {
    if (!el.isConnected) {
      exit();
    }
  }, 200);

  port.onMessage.addListener((message) => {
    for (const [type, value] of Object.entries(message)) {
      switch (type) {
        case "replaceAll":
          el.innerHTML = value;
          for (const blockquote of el.querySelectorAll('blockquote')) {
            blockquote.setAttribute('style', blockquoteStyle);
          }
          break;
        default:
          console.error("Invalid message type:", type);
          exit();
          break;
      }
    }
  });

  port.postMessage({"begin": {initialContent: el.innerHTML, contentType: "Plain"}});

})();
