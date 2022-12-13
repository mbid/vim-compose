import Port = chrome.runtime.Port;

export enum ContentType {
  Plain = "Plain",
  Html = "Html",
}

export namespace Client {
  export interface Begin {
    kind: "begin";
    initialContent: string;
    contentType: ContentType;
  }
  export type Message = Begin;

  export function validate(obj: {}): obj is Message {
    // TODO.
    return true;
  }
}

export namespace Host {
  export interface ReplaceAll {
    kind: "replaceAll";
    content: string;
  }
  export type Message = ReplaceAll;

  export function validate(obj: {}): obj is Message {
    // TODO.
    return true;
  }
}

export function connect(): Port {
  return chrome.runtime.connect({ name: "content" });
}
