import * as protocol from "./protocol";

/// An error indicating that communcation with the native host could not be established.
class MissingNativeHostError extends Error {
  constructor() {
    super("Missing native host");
  }
}

/// An error indicating that an element is not suitable for editing.
class NonEditableElementError extends Error {
  constructor() {
    super("Element cannot be edited");
  }
}

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

  // Just use the plain email instead of links. Useful so that lines such as
  // this one aren't obfuscated in markdown source:
  //
  //   On Sun, Dec 11, 2022 at 7:00 PM Martin Bidlingmaier
  //   <martin.bidlingmaier@gmail.com> wrote:
  for (const a of el.querySelectorAll('a[href^="mailto:"]')) {
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

function findGmailBlockquoteStyle(editable: HTMLElement): string {
  const def =
    "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";

  const blockquote = editable.querySelector("blockquote");
  if (blockquote == null) {
    return def;
  }

  const style = blockquote.getAttribute("style");
  if (style == null) {
    return def;
  }

  return style;
}

function preserveGmailBlockquoteStyle(
  editable: HTMLElement
): CancellablePromise<void> {
  const style: string = findGmailBlockquoteStyle(editable);

  function onMutation(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        if (addedNode instanceof HTMLQuoteElement) {
          addedNode.setAttribute("style", style);
        }

        if (addedNode instanceof Element) {
          for (const nestedBlockquote of addedNode.querySelectorAll(
            "blockquote"
          )) {
            nestedBlockquote.setAttribute("style", style);
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
  var hostSentMessage = false;
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
        reject(new NonEditableElementError());
        return;
      }

      const beginMessage: protocol.Client.Message = {
        kind: "begin",
        initialContent: initialContent,
        contentType: contentType,
      };
      port.postMessage(beginMessage);

      port.onDisconnect.addListener(() => {
        if (!hostSentMessage) {
          reject(new MissingNativeHostError());
        } else {
          resolve();
        }
      });

      port.onMessage.addListener((message) => {
        hostSentMessage = true;

        if (!protocol.Host.validate(message)) {
          reject("Invalid message");
          return;
        }

        switch (message.kind) {
          case "replaceAll":
            switch (contentType) {
              case protocol.ContentType.Html:
                // The HTML we get here should have been sanitized by the
                // native host already, so assigning to innerHTML is OK.
                // Nevertheless, we use setHTML if possible, which also
                // sanitizes.
                // As of this writing, firefox only supports setHTML as an
                // experimental feature, not by default.
                if (
                  "setHTML" in editable &&
                  typeof editable.setHTML === "function"
                ) {
                  editable.setHTML(message.content);
                } else {
                  editable.innerHTML = message.content;
                }
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
    throw new NonEditableElementError();
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
    if (el.disabled || el.readOnly) {
      throw new NonEditableElementError();
    }
    await CancellablePromise.race([
      edit(el),
      pollUntil(() => !el.isConnected),
      disableInput(el),
    ]);
    return;
  }

  throw new NonEditableElementError();
}

const errorBannerId = "vim-compose-error-banner-iepe2iPh1atoh6phai2y";

function removeErrorBanner() {
  const errorBanner = document.getElementById(errorBannerId);
  if (errorBanner) {
    errorBanner.remove();
  }
}

function createErrorBanner(message: string): HTMLElement {
  const container = document.createElement("div");
  container.id = errorBannerId;
  const shadowRoot = container.attachShadow({ mode: "open" });

  shadowRoot.innerHTML = `
    <style>
      :host {
        all: initial;

        display: block;
        position: fixed;
        left: 0;
        top: 0;
        z-index: 999999;
        width: 100%;
      }

      #error {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 0.5em;

        color: rgb(255, 255, 255);
        background-color: rgb(220, 53, 69);
        font-size: 1em;
      }

      #error a {
        color: yellow;
      }
    </style>
    <div id="error">
      ${message}
    </div>
  `;
  return container;
}

function displayError(message: string) {
  const errorBanner = createErrorBanner(message);
  document.body.prepend(errorBanner);
  setTimeout(() => {
    errorBanner.remove();
  }, 10000);
}

(async function () {
  removeErrorBanner();
  try {
    await tryEdit(document.activeElement);
  } catch (e) {
    if (e instanceof MissingNativeHostError) {
      displayError(`
        <b>Vim Compose: Native host is not installed</b>
        <div>
          Follow instructions at
          <a href="https://github.com/mbid/vim-compose">https://github.com/mbid/vim-compose</a>
        </div>
      `);
    } else if (e instanceof NonEditableElementError) {
      displayError(`
        <b>Vim Compose: Element cannot be edited</b>
      `);
    }
  }
})();
