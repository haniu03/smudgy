// Loader hooks that satisfy `smudgy:` imports with stub modules backed by
// globalThis.__smudgyStub, so the package can be evaluated under plain Node.

const SOURCES = new Map([
  ["smudgy:core", `
const S = globalThis.__smudgyStub;
export const vars = S.vars;
export const echo = (value, ...rest) => S.record("echo", S.textOf(value, rest));
export const send = (command) => S.record("send", command);
export const sendRaw = (text) => {
  S.requireGrant("session", "send-direct");
  S.record("sendRaw", text);
};
export const style = S.style;
export const input = S.input;
export const getSettings = () => ({ commandSeparator: ";", rawLinePrefix: "\\\\\\\\" });
export const submission = {
  get text() { return S.submission.text; },
  cancel() { S.submission.cancel(); },
  replace(text) { S.submission.replace(text); },
};
// The host validates automation names the way core/src/models/naming.rs does;
// mirror the character rules so name bugs fail here too.
const checkName = (name) => {
  if (name === undefined) return;
  const bad = String(name).match(/[<>:"/\\|?*]/);
  if (bad) throw new TypeError("Name cannot contain '" + bad[0] + "'");
  if (/[\u0000-\u001f]/.test(name)) throw new TypeError("Name cannot contain control characters");
  if (String(name).length > 64) throw new TypeError("Name cannot be longer than 64 characters");
};
export const createAlias = (patterns, script, options) => { checkName(options?.name); return S.create("alias", patterns, script, options); };
export const createTrigger = (patterns, script, options) => { checkName(options?.name); return S.create("trigger", patterns, script, options); };
export const createTimer = (options, callback) => { checkName(options?.name); return S.create("timer", options, callback, undefined); };
export const createHotkey = (keySpec, handler, options) => { checkName(options?.name); return S.create("hotkey", keySpec, handler, options); };
export const line = S.line;
export const capture = () => {};
export const getProfile = () => ({ name: "Tester" });
export const getDataDir = () => S.dataDir;
export const getSessions = () => S.sessions;
export const byName = (name) => S.sessions.find((target) => target.profile.name === name);
export const session = S.session;
`],
  ["smudgy:params", `
const S = globalThis.__smudgyStub;
export const get = (key) => S.params[key];
export default { get };
`],
  ["smudgy:events/sys", `
const S = globalThis.__smudgyStub;
const mk = (name) => ({
  on: (handler) => {
    (S.eventHandlers[name] ??= []).push(handler);
    return { off() { S.eventHandlers[name] = (S.eventHandlers[name] ?? []).filter((h) => h !== handler); } };
  },
});
export const connect = mk("connect");
export const disconnect = mk("disconnect");
export const send = mk("send");
export const receive = mk("receive");
export const submit = mk("submit");
`],
]);

export function resolve(specifier, context, next) {
  if (SOURCES.has(specifier)) {
    return { url: `virtual:${specifier}`, shortCircuit: true };
  }
  return next(specifier, context);
}

export function load(url, context, next) {
  if (url.startsWith("virtual:")) {
    return { format: "module", source: SOURCES.get(url.slice("virtual:".length)), shortCircuit: true };
  }
  return next(url, context);
}
