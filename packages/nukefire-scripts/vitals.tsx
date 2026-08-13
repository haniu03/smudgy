// Aggregated vitals for the all-sessions tab layout. Every runtime publishes
// one retained `sessionVitals` state; the primary reads directed views of that
// state and renders ordinary identity widgets above fixed-cap/stretch-center
// bar slices. Text and corner radii remain stable as the pane grows.

import {
  createState,
  getSessions,
  session,
  type BoundStateConsumer,
  type EventSubscription,
  type StateConsumer,
} from "smudgy:core";
import { focus as inputFocus } from "smudgy:events/input";
import { created, destroyed } from "smudgy:events/sessions";
import {
  Column,
  Container,
  Row,
  Space,
  createWidget,
  removeWidget,
  type CanvasShape,
} from "smudgy:widgets";
import {
  nukefire,
  watchMessage,
  type CharStatus,
  type CharVitals,
} from "smudgy://kapusniak/nukefire-gmcp";
// The self-consumer shim is generated from index.ts when the package is
// installed. The checked-in workspace typings describe the previously
// installed package version, so they cannot know this new export yet.
// @ts-ignore generated self-state module
import { sessionVitals as generatedSessionVitalsConsumer } from "smudgy:state/kapusniak/nukefire-scripts";
import { sessionVitalsLayout, widgetMetric } from "./config.ts";
import { sessionVitals } from "./index.ts";
import { UI, themeBackground } from "./theme.ts";
import {
  type BarSlices,
  buildVitalBarSlices,
  characterName,
  classAndLevel,
  compactVital,
  sessionBadge,
  vitalRatio,
  vitalReadoutColor,
  wideVital as sharedWideVital,
} from "./vitals-ui.tsx";

const PANE = "Vitals";
const WIDGET = "nf-session-vitals";

const COMPACT_PLAYER_HEIGHT = 52;
const WIDE_PLAYER_HEIGHT = 30;
const WIDE_IDENTITY_WIDTH = 125;
const WIDE_IDENTITY_GAP = 4;

export interface VitalsSnapshot {
  sessionId: number;
  name: string;
  className: string;
  level: number;
  focused: boolean;
  hp: number;
  mhp: number;
  mana: number;
  mmana: number;
  move: number;
  mmove: number;
}

interface PlayerDisplay {
  name: string;
  nameColor: string;
  className: string;
  levelLabel: string;
  detailSeparator: string;
  badgeScene: CanvasShape[];
  badgeColor: string;
  hpValue: string;
  manaValue: string;
  moveValue: string;
  hpValueColor: string;
  manaValueColor: string;
  moveValueColor: string;
  hpBar: BarSlices;
  manaBar: BarSlices;
  moveBar: BarSlices;
}

interface DirectedVitals {
  view: BoundStateConsumer<VitalsSnapshot>;
  subscription: EventSubscription;
}

interface VitalSpec {
  key: "hp" | "mana" | "move";
  current: number;
  maximum: number;
  gradient: readonly [string, string, string];
}

let status: Readonly<CharStatus> | undefined = nukefire.value?.Char?.Status;
let vitals: Readonly<CharVitals> | undefined = nukefire.value?.Char?.Vitals;
let initialized = false;
let shown = false;
let widgetMounted = false;
let mountedSessionIds = "";
let previousRatios = new Map<string, number>();
const cachedBarShapes = new Map<string, BarSlices>();

const directedConsumer = generatedSessionVitalsConsumer as StateConsumer<VitalsSnapshot>;
const directedVitals = new Map<number, DirectedVitals>();
const playerDisplay = createState<Record<string, PlayerDisplay>>("sessionVitalsDisplay");

function ownSnapshot(): VitalsSnapshot {
  return {
    sessionId: session.id,
    name: status?.name?.trim() || session.profile.name?.trim() || `Session ${session.id}`,
    className: status?.class ?? "",
    level: status?.level ?? 0,
    focused: session.input.focused,
    hp: vitals?.hp ?? 0,
    mhp: vitals?.mhp ?? 1,
    mana: vitals?.mana ?? 0,
    mmana: vitals?.mmana ?? 1,
    move: vitals?.move ?? 0,
    mmove: vitals?.mmove ?? 1,
  };
}

function publish(): void {
  if (!initialized) return;
  sessionVitals.set(ownSnapshot());
}

watchMessage("Char.Status", (next) => {
  status = next;
  publish();
});

watchMessage("Char.Vitals", (next) => {
  vitals = next;
  publish();
});

inputFocus.on(() => publish());

created.on(() => {
  setTimeout(() => {
    if (shown) render();
  }, 100);
});

destroyed.on(() => {
  setTimeout(() => {
    if (shown) render();
  }, 100);
});

export function initialize(): void {
  if (initialized) return;
  initialized = true;
  publish();
  // Reading `input.focused` asks the UI to begin mirroring input state. Its
  // first report establishes a baseline rather than emitting a focus edge, so
  // publish once more after that warm-up can arrive.
  setTimeout(publish, 100);
}

function placeholder(target: ReturnType<typeof getSessions>[number]): VitalsSnapshot {
  return {
    sessionId: target.id,
    name: target.profile.name?.trim() || `Session ${target.id}`,
    className: "",
    level: 0,
    focused: target.input.focused,
    hp: 0,
    mhp: 1,
    mana: 0,
    mmana: 1,
    move: 0,
    mmove: 1,
  };
}

function syncDirectedViews(sessions: ReturnType<typeof getSessions>): void {
  const liveIds = new Set(sessions.map((target) => target.id));
  for (const [sessionId, directed] of directedVitals) {
    if (liveIds.has(sessionId)) continue;
    directed.subscription.off();
    directedVitals.delete(sessionId);
  }

  for (const target of sessions) {
    if (directedVitals.has(target.id)) continue;
    const view = directedConsumer.from(target);
    const subscription = view.watch(() => {
      if (shown) render();
    });
    directedVitals.set(target.id, { view, subscription });
  }
}

function releaseDirectedViews(): void {
  for (const directed of directedVitals.values()) directed.subscription.off();
  directedVitals.clear();
}

function ordinalBadgeScene(active: boolean): CanvasShape[] {
  return [{
    kind: "rect",
    x: 0.5,
    y: 0.5,
    width: 29,
    height: 21,
    rx: 7,
    fill: active ? "rgba(252,191,73,0.13)" : "rgba(255,255,255,0.035)",
    stroke: {
      color: active ? UI.gold : "rgba(110,127,150,0.55)",
      width: 1,
    },
  }];
}

function displayFor(snapshot: Readonly<VitalsSnapshot>): PlayerDisplay {
  const specs: readonly VitalSpec[] = [
    {
      key: "hp",
      current: snapshot.hp,
      maximum: snapshot.mhp,
      gradient: ["#71131d", UI.hp, "#ff6672"],
    },
    {
      key: "mana",
      current: snapshot.mana,
      maximum: snapshot.mmana,
      gradient: ["#173a63", UI.mana, "#65b7e6"],
    },
    {
      key: "move",
      current: snapshot.move,
      maximum: snapshot.mmove,
      gradient: ["#155548", UI.move, "#55c5a5"],
    },
  ];
  const barScenes: BarSlices[] = [];

  specs.forEach((spec) => {
    const ratioKey = `${snapshot.sessionId}:${spec.key}`;
    const oldRatio = previousRatios.get(ratioKey);
    const nextRatio = vitalRatio(spec.current, spec.maximum);
    let shapes = cachedBarShapes.get(ratioKey);
    if (!shapes || oldRatio === undefined || Math.abs(oldRatio - nextRatio) > 0.0001) {
      shapes = buildVitalBarSlices(`session-${snapshot.sessionId}`, spec, oldRatio);
      cachedBarShapes.set(ratioKey, shapes);
    }
    barScenes.push(shapes);
    previousRatios.set(ratioKey, nextRatio);
  });

  return {
    name: snapshot.name,
    nameColor: snapshot.focused ? UI.gold : "#d8e0e8",
    className: snapshot.className || "connecting",
    levelLabel: snapshot.level > 0 ? `LV ${snapshot.level}` : "",
    detailSeparator: snapshot.className && snapshot.level > 0 ? "/" : "",
    badgeScene: ordinalBadgeScene(snapshot.focused),
    badgeColor: snapshot.focused ? UI.gold : UI.dim,
    hpValue: `${snapshot.hp} / ${snapshot.mhp}`,
    manaValue: `${snapshot.mana} / ${snapshot.mmana}`,
    moveValue: `${snapshot.move} / ${snapshot.mmove}`,
    hpValueColor: vitalReadoutColor(snapshot.hp, snapshot.mhp),
    manaValueColor: vitalReadoutColor(snapshot.mana, snapshot.mmana),
    moveValueColor: vitalReadoutColor(snapshot.move, snapshot.mmove),
    hpBar: barScenes[0] ?? { start: [], middle: [], end: [] },
    manaBar: barScenes[1] ?? { start: [], middle: [], end: [] },
    moveBar: barScenes[2] ?? { start: [], middle: [], end: [] },
  };
}

function updateDisplay(sessions: ReturnType<typeof getSessions>): void {
  const next: Record<string, PlayerDisplay> = {};
  const liveRatioKeys = new Set<string>();
  for (const target of sessions) {
    const snapshot = directedVitals.get(target.id)?.view.value ?? placeholder(target);
    next[String(target.id)] = displayFor(snapshot);
    liveRatioKeys.add(`${target.id}:hp`);
    liveRatioKeys.add(`${target.id}:mana`);
    liveRatioKeys.add(`${target.id}:move`);
  }
  for (const key of previousRatios.keys()) {
    if (liveRatioKeys.has(key)) continue;
    previousRatios.delete(key);
    cachedBarShapes.delete(key);
  }
  playerDisplay.set(next);
}

function displayPath(targetId: number, field: keyof PlayerDisplay): string {
  return `[${JSON.stringify(String(targetId))}].${field}`;
}

function ordinalBadge(targetId: number, ordinal: number) {
  return sessionBadge(
    ordinal,
    playerDisplay.bind(displayPath(targetId, "badgeScene"), { fallback: [] }),
    playerDisplay.bind(displayPath(targetId, "badgeColor"), { fallback: UI.dim }),
  );
}

type ValueKey = "hpValue" | "manaValue" | "moveValue";
type ValueColorKey = "hpValueColor" | "manaValueColor" | "moveValueColor";
type BarKey = "hpBar" | "manaBar" | "moveBar";

function barSlicePath(targetId: number, barKey: BarKey, slice: keyof BarSlices): string {
  return `${displayPath(targetId, barKey)}.${slice}`;
}

function barBindings(targetId: number, barKey: BarKey) {
  return {
    start: playerDisplay.bind(barSlicePath(targetId, barKey, "start"), { fallback: [] }),
    middle: playerDisplay.bind(barSlicePath(targetId, barKey, "middle"), { fallback: [] }),
    end: playerDisplay.bind(barSlicePath(targetId, barKey, "end"), { fallback: [] }),
  };
}

function vitalStack(
  targetId: number,
  label: "HP" | "MN" | "MV",
  valueKey: ValueKey,
  valueColorKey: ValueColorKey,
  barKey: BarKey,
  color: string,
) {
  return compactVital(
    label,
    playerDisplay.bind(displayPath(targetId, valueKey), { fallback: "—" }),
    playerDisplay.bind(displayPath(targetId, valueColorKey), { fallback: UI.bright }),
    barBindings(targetId, barKey),
    color,
  );
}

function identityText(target: ReturnType<typeof getSessions>[number]) {
  return [
    characterName(
      playerDisplay.bind(displayPath(target.id, "name"), {
        fallback: target.profile.name ?? "Session",
      }),
      13,
      playerDisplay.bind(displayPath(target.id, "nameColor"), { fallback: UI.bright }),
    ),
    classAndLevel(
      playerDisplay.bind(displayPath(target.id, "className"), { fallback: "connecting" }),
      playerDisplay.bind(displayPath(target.id, "levelLabel"), { fallback: "" }),
      10,
      playerDisplay.bind(displayPath(target.id, "detailSeparator"), { fallback: "" }),
    ),
  ];
}

function wideVital(
  targetId: number,
  label: "HP" | "MN" | "MV",
  valueKey: ValueKey,
  valueColorKey: ValueColorKey,
  barKey: BarKey,
  color: string,
) {
  return sharedWideVital(
    label,
    playerDisplay.bind(displayPath(targetId, valueKey), { fallback: "—" }),
    playerDisplay.bind(displayPath(targetId, valueColorKey), { fallback: UI.bright }),
    barBindings(targetId, barKey),
    color,
  );
}

function compactPlayerRow(
  target: ReturnType<typeof getSessions>[number],
  ordinal: number,
) {
  return (
    <Container width="fill" height={widgetMetric(COMPACT_PLAYER_HEIGHT)}>
      <Column width="fill" height="fill" padding={3} spacing={1}>
        <Row width="fill" height={widgetMetric(22)} spacing={7}>
          {[ordinalBadge(target.id, ordinal), ...identityText(target), <Space width="fill" />]}
        </Row>
        <Row width="fill" height={widgetMetric(18)} spacing={4}>
          {[
            vitalStack(target.id, "HP", "hpValue", "hpValueColor", "hpBar", UI.hp),
            vitalStack(target.id, "MN", "manaValue", "manaValueColor", "manaBar", UI.mana),
            vitalStack(target.id, "MV", "moveValue", "moveValueColor", "moveBar", UI.move),
          ]}
        </Row>
      </Column>
    </Container>
  );
}

function widePlayerRow(
  target: ReturnType<typeof getSessions>[number],
  ordinal: number,
) {
  return (
    <Container
      width="fill"
      height={widgetMetric(WIDE_PLAYER_HEIGHT)}
    >
      <Row width="fill" height="fill" padding={0} spacing={widgetMetric(WIDE_IDENTITY_GAP)}>
        {[
          ordinalBadge(target.id, ordinal),
          <Column width={widgetMetric(WIDE_IDENTITY_WIDTH)} height="fill" spacing={0}>
            {identityText(target)}
          </Column>,
          <Row width="fill" height="fill" spacing={widgetMetric(14)}>
            {[
              wideVital(target.id, "HP", "hpValue", "hpValueColor", "hpBar", UI.hp),
              wideVital(target.id, "MN", "manaValue", "manaValueColor", "manaBar", UI.mana),
              wideVital(target.id, "MV", "moveValue", "moveValueColor", "moveBar", UI.move),
            ]}
          </Row>,
        ]}
      </Row>
    </Container>
  );
}

function playerRow(target: ReturnType<typeof getSessions>[number], index: number) {
  const ordinal = index + 1;
  return sessionVitalsLayout === "wide"
    ? widePlayerRow(target, ordinal)
    : compactPlayerRow(target, ordinal);
}

function playerHeight(): number {
  return sessionVitalsLayout === "wide" ? WIDE_PLAYER_HEIGHT : COMPACT_PLAYER_HEIGHT;
}

function desiredHeight(sessionCount: number): number {
  const count = Math.max(1, sessionCount);
  const spacing = sessionVitalsLayout === "wide" ? 0 : 2;
  const outerPadding = sessionVitalsLayout === "wide" ? 0 : 4;
  return widgetMetric(outerPadding + count * playerHeight() + Math.max(0, count - 1) * spacing);
}

function render(): void {
  if (!shown) return;
  const sessions = getSessions();
  if (sessions[0]?.id !== session.id) return;
  const pane = session.panes.get(PANE);
  if (!pane) return;

  syncDirectedViews(sessions);
  updateDisplay(sessions);
  const sessionIds = sessions.map((target) => target.id).join(",");
  const structureChanged = mountedSessionIds !== sessionIds;

  if (structureChanged) {
    mountedSessionIds = sessionIds;
    pane.resize({ height: desiredHeight(sessions.length) });
  }

  if (!widgetMounted || structureChanged) {
    createWidget(
      WIDGET,
      <Container width="fill" height="fill" background={themeBackground.bind()}>
        <Column
          width="fill"
          height="fill"
          padding={sessionVitalsLayout === "wide" ? 0 : widgetMetric(2)}
          spacing={sessionVitalsLayout === "wide" ? 0 : widgetMetric(2)}
        >
          {sessions.map(playerRow)}
        </Column>
      </Container>,
      { pane },
    );
    widgetMounted = true;
  }
}

export function open(): void {
  if (getSessions()[0]?.id !== session.id) return;
  const sessions = getSessions();
  session.mainPane.split("top", {
    name: PANE,
    height: desiredHeight(sessions.length),
    terminal: false,
  });
  shown = true;
  widgetMounted = false;
  mountedSessionIds = sessions.map((target) => target.id).join(",");
  previousRatios.clear();
  cachedBarShapes.clear();
  render();
}

export function close(): void {
  shown = false;
  widgetMounted = false;
  mountedSessionIds = "";
  previousRatios.clear();
  cachedBarShapes.clear();
  releaseDirectedViews();
  removeWidget(WIDGET);
  session.panes.get(PANE)?.close();
}
