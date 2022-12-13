function flatten(el: Element) {
  if (!el.parentElement) {
    return;
  }

  while (el.childNodes.length > 0) {
    el.parentElement.insertBefore(el.childNodes[0], el);
  }
  el.remove();
}

function findBlockquoteStyle(editable: Element): string | null {
  for (const blockquote of editable.querySelectorAll("blockquote")) {
    const style = blockquote.getAttribute("style");
    if (style) {
      return style;
    }
  }

  return null;
}

function isGmailComposeInput(el: Element): boolean {
  return (
    el instanceof HTMLElement &&
    el.isContentEditable &&
    el.getAttribute("g_editable") === "true"
  );
}

function domDistance(lhs: Element, rhs: Element): number | null {
  let lhs_ancestors = new Map();
  let rhs_ancestors = new Map();

  let lhs_tip: ParentNode | null = lhs;
  let rhs_tip: ParentNode | null = rhs;

  while (true) {
    if (!lhs_tip && !rhs_tip) {
      return null;
    }

    if (lhs_tip != null) {
      const rhs_index = rhs_ancestors.get(lhs_tip);
      if (rhs_index != null) {
        return lhs_ancestors.size + rhs_index;
      }
      lhs_ancestors.set(lhs_tip, lhs_ancestors.size);
      lhs_tip = lhs_tip.parentNode;
    }

    [lhs_tip, rhs_tip] = [rhs_tip, lhs_tip];
    [lhs_ancestors, rhs_ancestors] = [rhs_ancestors, lhs_ancestors];
  }
}

function prepareGmailComposeInput(el: HTMLElement) {
  // Try to click the "Show trimmed content" to unfold the mail we're
  // replying to.
  const rootNode = el.getRootNode();
  if (rootNode instanceof HTMLDocument || rootNode instanceof ShadowRoot) {
    const showTrimmedButtons = [
      ...rootNode.querySelectorAll(
        'div[role="button"][aria-label="Show trimmed content"]'
      ),
    ];

    if (showTrimmedButtons.length > 0) {
      const domDists = showTrimmedButtons.map(
        (but) => domDistance(but, el) || Math.max()
      );
      const minDist = Math.min(...domDists);
      if (minDist <= 15) {
        const showTrimmedButton = showTrimmedButtons[domDists.indexOf(minDist)];
        if (showTrimmedButton instanceof HTMLElement) {
          showTrimmedButton.click();
        }
      }
    }
  }

  // Just use the plain email instead of link in lines before quotes such as this one:
  //
  //   On Sun, Dec 11, 2022 at 7:00 PM Martin Bidlingmaier
  //   <martin.bidlingmaier@gmail.com> wrote:
  for (const a of el.querySelectorAll('div.gmail_attr a[href^="mailto:"]')) {
    flatten(a);
  }

  // Flatten some divs without inserting newlines.
  for (const div of el.querySelectorAll("div.gmail_quote")) {
    flatten(div);
  }
  for (const div of el.querySelectorAll("div.gmail_attr")) {
    flatten(div);
  }
}

function prepareContentEditable(el: HTMLElement) {
  for (const div of el.querySelectorAll("div")) {
    if (div.parentNode) {
      div.parentNode.insertBefore(
        document.createElement("br"),
        div.nextSibling
      );
    }
    flatten(div);
  }
}

function editWithVim(editable: HTMLElement) {
  console.assert(editable.isContentEditable);
  const blockquoteStyle = findBlockquoteStyle(editable);
  editable.setAttribute("contenteditable", false.toString());

  const port = chrome.runtime.connect({ name: "content" });
  var timer: number | null = null;

  function exit() {
    port.disconnect();
    if (timer != null) {
      clearTimeout(timer);
    }
    editable.setAttribute("contenteditable", true.toString());
  }

  port.onDisconnect.addListener(exit);

  timer = window.setInterval(() => {
    if (!editable.isConnected) {
      exit();
    }
  }, 100);

  port.onMessage.addListener((message) => {
    const entries = Object.entries(message);
    if (entries.length != 1) {
      console.error("Invalid message");
    }
    const [[type, value]] = entries;
    switch (type) {
      case "replaceAll":
        if (typeof value !== "string") {
          console.error("Invalid replaceAll message");
          return;
        }

        editable.innerHTML = value;
        if (blockquoteStyle != null) {
          for (const blockquote of editable.querySelectorAll("blockquote")) {
            blockquote.setAttribute("style", blockquoteStyle);
          }
        }
        break;
      default:
        console.error("Invalid message type:", type);
        return;
    }
  });

  port.postMessage({
    begin: { initialContent: editable.innerHTML, contentType: "Plain" },
  });
}

function tryEdit(el: Element | null) {
  if (!(el instanceof HTMLElement)) {
    return;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    console.error("TODO");
    return;
  }

  if (el.isContentEditable !== true) {
    return false;
  }

  if (isGmailComposeInput(el)) {
    prepareGmailComposeInput(el);
  }
  prepareContentEditable(el);
  editWithVim(el);
}

tryEdit(document.activeElement);
