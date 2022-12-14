import * as protocol from "./protocol";

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

// TODO: Make it so that cancel means that neither resolve or reject are
// called, and that cancel is called at most once.
type Executor<T> = (
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason?: any) => void
) => void;
class CancellablePromise<T> extends Promise<T> {
  constructor(executor: Executor<T>, cancel: () => void) {
    super(executor);
    this.cancelMethod = cancel;
  }

  public cancel() {
    this.cancelMethod();
  }

  // TODO: Should return a CancellablePromise.
  public static async race<S>(ps: CancellablePromise<S>[]): Promise<S> {
    try {
      return await Promise.race(ps);
    } finally {
      for (const p of ps) {
        p.cancel();
      }
    }
  }

  public static never<S>(): CancellablePromise<S> {
    return new CancellablePromise<S>(
      () => {},
      () => {}
    );
  }

  private cancelMethod: () => void;
}

function preserveGmailBlockquoteStyle(
  editable: HTMLElement
): CancellablePromise<void> {
  const blockquote = editable.querySelector("blockquote");
  if (blockquote == null) {
    return CancellablePromise.never();
  }

  const style = blockquote.getAttribute("style");
  if (style == null) {
    return CancellablePromise.never();
  }
  const blockquoteStyle: string = style;

  function onMutation(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        if (addedNode instanceof HTMLQuoteElement) {
          addedNode.setAttribute("style", blockquoteStyle);
        }

        if (addedNode instanceof Element) {
          for (const nestedBlockquote of addedNode.querySelectorAll(
            "blockquote"
          )) {
            nestedBlockquote.setAttribute("style", blockquoteStyle);
          }
        }
      }
    }
  }

  const mutationObserver = new MutationObserver(onMutation);
  mutationObserver.observe(editable, { subtree: true, childList: true });
  return new CancellablePromise<void>(
    () => {},
    () => {
      mutationObserver.disconnect();
    }
  );
}

function pollUntil(property: () => boolean): CancellablePromise<void> {
  var timer: number | null = null;
  return new CancellablePromise<void>(
    (resolve) => {
      timer = window.setInterval(() => {
        if (property()) {
          resolve();
        }
      }, 100);
    },
    () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }
  );
}

function edit(editable: HTMLElement): CancellablePromise<void> {
  var port: Port | null;
  return new CancellablePromise<void>(
    (resolve, reject) => {
      port = protocol.connect();

      var contentType: protocol.ContentType | null = null;
      var initialContent: string | null = null;
      if (
        editable instanceof HTMLInputElement ||
        editable instanceof HTMLTextAreaElement
      ) {
        contentType = protocol.ContentType.Plain;
        initialContent = editable.value;
      } else if (editable.isContentEditable) {
        contentType = protocol.ContentType.Html;
        initialContent = editable.innerHTML;
      } else {
        reject("Invalid edit element");
        return;
      }

      const beginMessage: protocol.Client.Message = {
        kind: "begin",
        initialContent: initialContent,
        contentType: contentType,
      };
      port.postMessage(beginMessage);

      port.onDisconnect.addListener(() => {
        resolve();
      });

      port.onMessage.addListener((message) => {
        if (!protocol.Host.validate(message)) {
          reject("Invalid message");
          return;
        }

        switch (message.kind) {
          case "replaceAll":
            switch (contentType) {
              case protocol.ContentType.Html:
                editable.innerHTML = message.content;
                break;
              case protocol.ContentType.Plain:
                (editable as HTMLElement & { value: string }).value =
                  message.content;
                break;
            }
            break;
        }
      });
    },
    () => {
      if (port != null) {
        port.disconnect();
      }
    }
  );
}

function disableContentEditable(el: HTMLElement): CancellablePromise<void> {
  return new CancellablePromise<void>(
    () => {
      el.setAttribute("contenteditable", false.toString());
      // We intentionally never resolve.
    },
    () => {
      el.setAttribute("contenteditable", true.toString());
    }
  );
}

function disableInput(
  el: HTMLInputElement | HTMLTextAreaElement
): CancellablePromise<void> {
  return new CancellablePromise<void>(
    () => {
      el.setAttribute("readonly", true.toString());
      // We intentionally never resolve.
    },
    () => {
      el.removeAttribute("readonly");
    }
  );
}

async function tryEdit(el: Element | null) {
  if (!(el instanceof HTMLElement)) {
    return;
  }

  if (el.isContentEditable === true) {
    const procs: CancellablePromise<void>[] = [];
    if (isGmailComposeInput(el)) {
      prepareGmailComposeInput(el);
      procs.push(preserveGmailBlockquoteStyle(el));
    }
    prepareContentEditable(el);

    procs.push(
      ...[
        edit(el),
        pollUntil(() => !el.isConnected),
        disableContentEditable(el),
      ]
    );
    await CancellablePromise.race(procs);
    return;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    await CancellablePromise.race([
      edit(el),
      pollUntil(() => !el.isConnected),
      disableInput(el),
    ]);
    return;
  }
}

tryEdit(document.activeElement);
