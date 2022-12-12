function flatten(el) {
  if (!el.parentElement) {
    return;
  }

  while (el.childNodes.length > 0) {
    el.parentElement.insertBefore(el.childNodes[0], el);
  }
  el.remove();
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

function isComposeInput(el) {
  return el instanceof HTMLElement && el.getAttribute('contenteditable') === 'true' && el.getAttribute('g_editable') === 'true';
}

function editWithVim(inputBox) {
  console.assert(inputBox.isContentEditable);
  const blockquoteStyle = findBlockquoteStyle(inputBox);
  inputBox.setAttribute("contenteditable", false);

  const port = chrome.runtime.connect({name: "content"});
  var intervalId;

  function exit() {
    port.disconnect();
    clearTimeout(intervalID);
    inputBox.setAttribute("contenteditable", true);
  }

  port.onDisconnect.addListener(exit);

  intervalID = setInterval(() => {
    if (!inputBox.isConnected) {
      exit();
    }
  }, 100);

  port.onMessage.addListener((message) => {
    for (const [type, value] of Object.entries(message)) {
      switch (type) {
        case "replaceAll":
          inputBox.innerHTML = value;
          for (const blockquote of inputBox.querySelectorAll('blockquote')) {
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

  port.postMessage({"begin": {initialContent: inputBox.innerHTML, contentType: "Plain"}});
}

function domDistance(lhs, rhs) {
  const lhs_ancestors = new Map();
  const rhs_ancestors = new Map();

  let lhs_tip = lhs;
  let rhs_tip = rhs;

  while (true) {
    if (!lhs_tip && !rhs_tip) {
      return;
    }

    if (lhs_tip) {
      const rhs_index = rhs_ancestors.get(lhs_tip);
      if (rhs_index != null) {
        return lhs_ancestors.size + rhs_index;
      }
      lhs_ancestors.set(lhs_tip, lhs_ancestors.size);
      lhs_tip = lhs_tip.parentNode;
    }

    if (rhs_tip) {
      const lhs_index = lhs_ancestors.get(rhs_tip);
      if (lhs_index != null) {
        return rhs_ancestors.size + lhs_index;
      }
      rhs_ancestors.set(rhs_tip, rhs_ancestors.size);
      rhs_tip = rhs_tip.parentNode;
    }
  }
}

function prepareEdit(el) {
  const rootNode = el.getRootNode();
  if (rootNode) {
    const showTrimmedButtons =
        [...rootNode.querySelectorAll('div[role="button"][aria-label="Show trimmed content"]')];
    console.log(showTrimmedButtons);

    if (showTrimmedButtons.length > 0) {
      const domDists = showTrimmedButtons.map((but) => domDistance(but, el));
      const minDist = Math.min(...domDists);
      if (minDist <= 15) {
        const showTrimmedButton = showTrimmedButtons[domDists.indexOf(minDist)];
        showTrimmedButton.click();
      }
    }
  }

  for (const div of el.querySelectorAll('div.gmail_quote')) {
    flatten(div);
  }

  for (const div of el.querySelectorAll('div.gmail_attr')) {
    flatten(div);
  }

  for (const div of el.querySelectorAll('div')) {
    if (div.parentNode) {
      div.parentNode.insertBefore(document.createElement("br"), div.nextSibling);
    }
    flatten(div);
  }

  for (const a of el.querySelectorAll('a[href^="mailto:"]')) {
    flatten(a);
  }
}

var alreadyEdited = false;
function tryEdit(el) {
  console.log("tryEdit");
  if (!isComposeInput(el)) {
    console.log("no compose");
    alreadyEdited = false;
    return;
  }

  if (alreadyEdited) {
    console.log("already edited");
    return;
  }

    console.log("editing");
  alreadyEdited = true;
  prepareEdit(el);
  editWithVim(el);
}

tryEdit(document.activeElement);

//document.body.addEventListener('focusin', (event) => {
//  tryEdit(event.Target);
//});
