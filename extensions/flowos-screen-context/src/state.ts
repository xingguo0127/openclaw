// In-memory per-session "screen context" for the FlowOS phone: split-screen (collab) and
// half-modal panel summoned from a foreground app (ambient). Two parallel kinds of the same idea:
// push a light header every turn, let the agent pull details on demand
// (nodes invoke screen.viewtree / screen.capture).
//
// Deliberately not persisted: process-local, ephemeral, keyed by bare session id.
// ambient has no "exited": every panel summon opens a new session, so the state dies with the key.

const BRACKETED_SYSTEM_TAG_RE = /\[\s*(System\s*Message|System|Assistant|Internal)\s*\]/gi;
const LINE_SYSTEM_PREFIX_RE = /^(\s*)System:(?=\s|$)/gim;
const MAX_FIELD_LENGTH = 200;
const MAX_SESSIONS = 512;

/** Neutralize device-supplied strings (app labels, page titles) that spoof system markers. */
export function sanitizeField(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const cleaned = input
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, MAX_FIELD_LENGTH)
    .replace(BRACKETED_SYSTEM_TAG_RE, (_m, tag: string) => `(${tag})`)
    .replace(LINE_SYSTEM_PREFIX_RE, "$1System (untrusted):");
  return cleaned || null;
}

/**
 * Bare session id. Devices send "session_xxx" while the reply side sees "agent:<id>:session_xxx";
 * both ends drop the "agent:<id>:" prefix so set/get use the same key.
 */
export function bareSessionKey(key: unknown): string | null {
  if (typeof key !== "string") {
    return null;
  }
  const trimmed = key.trim().replace(/^agent:[^:]+:/, "");
  return trimmed || null;
}

export type CollabState = {
  leftPackage: string | null;
  leftAppLabel: string | null;
  readable: boolean;
  /** FLAG_SECURE page: tree unreadable AND screenshots unavailable (readable=false alone still allows screenshots). */
  secure: boolean;
  since: number;
};

export type AmbientState = {
  pkg: string | null;
  appLabel: string | null;
  title: string | null;
  readable: boolean;
  secure: boolean;
  /** Text nodes serialized on the device (not "visible" nodes; see the device-side note). 0 = nothing readable. */
  nodeCount: number;
  since: number;
};

function bool(value: unknown): boolean {
  return value === true || value === "true";
}

function setBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

export class ScreenContextStore {
  private readonly collab = new Map<string, CollabState>();
  private readonly ambient = new Map<string, AmbientState>();

  setCollab(sessionKey: string, input: Record<string, unknown>, now = Date.now()): CollabState {
    const state: CollabState = {
      leftPackage: sanitizeField(input.leftPackage),
      leftAppLabel: sanitizeField(input.leftAppLabel),
      readable: bool(input.readable),
      secure: bool(input.secure),
      since: now,
    };
    setBounded(this.collab, sessionKey, state);
    return state;
  }

  clearCollab(sessionKey: string): void {
    this.collab.delete(sessionKey);
  }

  setAmbient(sessionKey: string, input: Record<string, unknown>, now = Date.now()): AmbientState {
    const n = Number(input.nodeCount ?? 0);
    const state: AmbientState = {
      pkg: sanitizeField(input.package),
      appLabel: sanitizeField(input.appLabel),
      title: sanitizeField(input.title),
      readable: bool(input.readable),
      secure: bool(input.secure),
      nodeCount: Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0,
      since: now,
    };
    setBounded(this.ambient, sessionKey, state);
    return state;
  }

  buildPrompt(sessionKey: unknown): string | null {
    const key = bareSessionKey(sessionKey);
    if (!key) {
      return null;
    }
    const parts = [
      buildCollabPrompt(this.collab.get(key)),
      buildAmbientPrompt(this.ambient.get(key)),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
}

export function buildCollabPrompt(state: CollabState | undefined): string | null {
  if (!state) {
    return null;
  }
  const label = state.leftAppLabel ?? state.leftPackage ?? "未知应用";
  const pkgSuffix = state.leftPackage && state.leftAppLabel ? `(${state.leftPackage})` : "";
  const lines = [
    "【分屏协作态】当前处于折叠机分屏:左侧是第三方 app,右侧是你(floai)。",
    `左侧应用:${label}${pkgSuffix};左侧内容${
      state.readable ? "可读" : state.secure ? "不可读(安全页)" : "文本树读不到内容(但可截图)"
    }。`,
  ];
  // Three states, not two: an empty text tree does not mean nothing can be seen; screenshots still work.
  if (state.readable) {
    lines.push(
      // Do not teach {pane:'left'}: the device ignores it (it decides which window to read) and
      // the skill docs say not to pass pane.
      "当用户问及左侧、或需基于左侧信息作答时,用 nodes 工具读取左屏:" +
        "invoke screen.viewtree 取结构化文本树、invoke screen.capture 截图(都不需要传参数)。" +
        "不必每轮都读,按需读取。",
    );
  } else if (state.secure) {
    lines.push(
      "左侧是安全页(如银行/密码页),**文本树和截图都拿不到**,两种都不要尝试;" +
        "如用户追问,直接说明该页受系统保护、无法读取。",
    );
  } else {
    lines.push(
      "左侧文本树读不到内容(多半是自绘界面/游戏/稀疏 Compose 树),**不要用 screen.viewtree**;" +
        "但 **screen.capture 截图仍然可用** —— 需要知道左侧显示什么就截图看。",
    );
  }
  lines.push("当前阶段仅支持读取左侧,不要尝试点击/输入/操作左侧。");
  return lines.join("\n");
}

export function buildAmbientPrompt(state: AmbientState | undefined): string | null {
  if (!state) {
    return null;
  }
  const label = state.appLabel ?? state.pkg ?? "未知应用";
  const pkgSuffix = state.pkg && state.appLabel ? `(${state.pkg})` : "";
  const lines = [
    "【当前应用】用户是在下面这个 app 前台唤起你的(半模态面板),不是从桌面进来的。",
    `应用:${label}${pkgSuffix}${state.title ? `;页面标题:${state.title}` : ""};` +
      `页面${
        state.readable
          ? `可读(文本节点 ${state.nodeCount} 个)`
          : state.secure
            ? "不可读(安全页)"
            : "文本树读不到内容(但可截图)"
      }。`,
  ];
  if (state.readable) {
    lines.push(
      "当用户问及「这个页面/屏幕上/这条」、或需基于页面信息作答时,用 nodes 工具读取:" +
        "invoke screen.viewtree 取结构化文本树、invoke screen.capture 截图(都不需要传参数,读哪个窗口由端侧决定)。" +
        "不必每轮都读,按需读取;上面的元信息够回答的就直接答,别白读一次。",
    );
  } else if (state.secure) {
    lines.push(
      "页面是安全页(如银行/密码页),**文本树和截图都拿不到**,两种都不要尝试;" +
        "如用户追问,直接说明该页受系统保护、无法读取。",
    );
  } else {
    lines.push(
      "页面文本树读不到内容(多半是自绘界面/游戏/稀疏 Compose 树),**不要用 screen.viewtree**;" +
        "但 **screen.capture 截图仍然可用** —— 需要知道页面显示什么就截图看。",
    );
  }
  lines.push(
    "以上是**唤起那一刻**的快照;若用户中途切到了别的 app 再追问,以重新读取的结果为准。" +
      "当前阶段仅支持读取,不要尝试点击/输入/操作用户的 app。",
  );
  return lines.join("\n");
}
