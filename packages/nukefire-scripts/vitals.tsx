// Aggregated vitals for the all-sessions tab layout. Every runtime publishes
// one retained `sessionVitals` state; the primary reads directed views of that
// state and renders ordinary identity widgets over one bar-only canvas per
// player. Canvas geometry may stretch, but text never does.

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
  Canvas,
  Column,
  Container,
  Row,
  Space,
  Stack,
  Text,
  createWidget,
  removeWidget,
  type CanvasFill,
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
import { sessionVitalsLayout, widgetMetric, widgetTextSize } from "./config.ts";
import { sessionVitals } from "./index.ts";
import { UI, themeBackground } from "./theme.ts";

const PANE = "Session Vitals";
const WIDGET = "nf-session-vitals";

const BAR_VIEW_WIDTH = 100;
const BAR_VIEW_HEIGHT = 20;
const BAR_WIDTH = 96;
const BAR_HEIGHT = 14;
const TWEEN_MS = 320;
const COMPACT_PLAYER_HEIGHT = 52;
const WIDE_PLAYER_HEIGHT = 38;
const WIDE_IDENTITY_WIDTH = 240;
const WIDE_VITAL_WIDTH = 210;

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
  details: string;
  badgeScene: CanvasShape[];
  badgeColor: string;
  hpLabel: string;
  manaLabel: string;
  moveLabel: string;
  hpBars: CanvasShape[];
  manaBars: CanvasShape[];
  moveBars: CanvasShape[];
}

interface DirectedVitals {
  view: BoundStateConsumer<VitalsSnapshot>;
  subscription: EventSubscription;
}

interface VitalSpec {
  key: "hp" | "mana" | "move";
  label: "HP" | "MN" | "MV";
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
const cachedBarShapes = new Map<string, CanvasShape[]>();

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

function ratio(current: number, maximum: number): number {
  return Math.min(1, Math.max(0, current / Math.max(1, maximum)));
}

function gradient(
  from: [number, number],
  to: [number, number],
  stops: readonly [string, string, string],
): CanvasFill {
  return {
    gradient: {
      from,
      to,
      stops: [[0, stops[0]], [0.55, stops[1]], [1, stops[2]]],
    },
  };
}

function barShapes(
  sessionId: number,
  spec: VitalSpec,
  oldRatio: number | undefined,
): CanvasShape[] {
  const nextRatio = ratio(spec.current, spec.maximum);
  const fillWidth = BAR_WIDTH * nextRatio;
  const fromWidth = BAR_WIDTH * (oldRatio ?? nextRatio);
  const shouldTween = oldRatio !== undefined && Math.abs(oldRatio - nextRatio) > 0.0001;
  const widthTween = shouldTween
    ? { width: { from: fromWidth, to: fillWidth, duration: TWEEN_MS, ease: "out" as const } }
    : undefined;
  const x = 2;
  const y = 3;
  const shapeId = `session-${sessionId}-${spec.key}`;

  return [
    {
      kind: "rect",
      x,
      y,
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      rx: 5,
      fill: gradient(
        [x, y],
        [x + BAR_WIDTH, y],
        ["rgba(255,255,255,0.035)", "rgba(10,18,32,0.78)", "rgba(255,255,255,0.055)"],
      ),
      stroke: { color: "rgba(110,127,150,0.52)", width: 1 },
    },
    {
      kind: "rect",
      id: `${shapeId}-fill`,
      x,
      y,
      width: fillWidth,
      height: BAR_HEIGHT,
      rx: 5,
      fill: gradient([x, y], [x + BAR_WIDTH, y], spec.gradient),
      animate: widthTween,
    },
    {
      kind: "rect",
      id: `${shapeId}-gloss`,
      x: x + 1,
      y: y + 1,
      width: Math.max(0, fillWidth - 2),
      height: 5,
      rx: 4,
      fill: gradient(
        [x, y + 1],
        [x, y + 7],
        ["rgba(255,255,255,0.44)", "rgba(255,255,255,0.17)", "rgba(255,255,255,0.01)"],
      ),
      opacity: 0.72,
      animate: shouldTween
        ? {
          width: {
            from: Math.max(0, fromWidth - 2),
            to: Math.max(0, fillWidth - 2),
            duration: TWEEN_MS,
            ease: "out",
          },
        }
        : undefined,
    },
  ];
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
      label: "HP",
      current: snapshot.hp,
      maximum: snapshot.mhp,
      gradient: ["#71131d", UI.hp, "#ff6672"],
    },
    {
      key: "mana",
      label: "MN",
      current: snapshot.mana,
      maximum: snapshot.mmana,
      gradient: ["#173a63", UI.mana, "#65b7e6"],
    },
    {
      key: "move",
      label: "MV",
      current: snapshot.move,
      maximum: snapshot.mmove,
      gradient: ["#155548", UI.move, "#55c5a5"],
    },
  ];
  const barScenes: CanvasShape[][] = [];

  specs.forEach((spec) => {
    const ratioKey = `${snapshot.sessionId}:${spec.key}`;
    const oldRatio = previousRatios.get(ratioKey);
    const nextRatio = ratio(spec.current, spec.maximum);
    let shapes = cachedBarShapes.get(ratioKey);
    if (!shapes || oldRatio === undefined || Math.abs(oldRatio - nextRatio) > 0.0001) {
      shapes = barShapes(snapshot.sessionId, spec, oldRatio);
      cachedBarShapes.set(ratioKey, shapes);
    }
    barScenes.push(shapes);
    previousRatios.set(ratioKey, nextRatio);
  });

  return {
    name: snapshot.name,
    details: snapshot.className === ""
      ? ""
      : `${snapshot.className}${snapshot.level > 0 ? ` · level ${snapshot.level}` : ""}`,
    badgeScene: ordinalBadgeScene(snapshot.focused),
    badgeColor: snapshot.focused ? UI.gold : UI.dim,
    hpLabel: `${snapshot.hp}/${snapshot.mhp} HP`,
    manaLabel: `${snapshot.mana}/${snapshot.mmana} MN`,
    moveLabel: `${snapshot.move}/${snapshot.mmove} MV`,
    hpBars: barScenes[0] ?? [],
    manaBars: barScenes[1] ?? [],
    moveBars: barScenes[2] ?? [],
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
  return (
    <Stack width={widgetMetric(30)} height={widgetMetric(22)}>
      <Canvas
        width="fill"
        height="fill"
        view_box={[0, 0, 30, 22]}
        fit="fill"
        scene={playerDisplay.bind(displayPath(targetId, "badgeScene"), { fallback: [] })}
      />
      <Container width="fill" height="fill" align_x="center" align_y="center">
        <Text
          size={widgetTextSize(13)}
          color={playerDisplay.bind(displayPath(targetId, "badgeColor"), { fallback: UI.dim })}
        >
          {ordinal}
        </Text>
      </Container>
    </Stack>
  );
}

type LabelKey = "hpLabel" | "manaLabel" | "moveLabel";
type BarKey = "hpBars" | "manaBars" | "moveBars";

function vitalStack(
  targetId: number,
  labelKey: LabelKey,
  barKey: BarKey,
  width: number | "fill",
  textSize: number,
) {
  return (
    <Stack width={width} height={widgetMetric(BAR_VIEW_HEIGHT)}>
      <Canvas
        width="fill"
        height="fill"
        view_box={[0, 0, BAR_VIEW_WIDTH, BAR_VIEW_HEIGHT]}
        fit="fill"
        scene={playerDisplay.bind(displayPath(targetId, barKey), { fallback: [] })}
      />
      <Container width="fill" height="fill" align_x="center" align_y="center">
        <Text size={widgetTextSize(textSize)} color={UI.bright}>
          {playerDisplay.bind(displayPath(targetId, labelKey), { fallback: "—" })}
        </Text>
      </Container>
    </Stack>
  );
}

function identityText(target: ReturnType<typeof getSessions>[number]) {
  return [
    <Text size={widgetTextSize(13)} color={UI.gold}>
      {playerDisplay.bind(displayPath(target.id, "name"), {
        fallback: target.profile.name ?? "Session",
      })}
    </Text>,
    <Text size={widgetTextSize(10)} color={UI.teal}>
      {playerDisplay.bind(displayPath(target.id, "details"), { fallback: "" })}
    </Text>,
  ];
}

function compactPlayerRow(
  target: ReturnType<typeof getSessions>[number],
  ordinal: number,
) {
  return (
    <Container
      width="fill"
      height={widgetMetric(COMPACT_PLAYER_HEIGHT)}
      background="rgba(20,29,61,0.46)"
    >
      <Column width="fill" height="fill" padding={3} spacing={1}>
        <Row width="fill" height={widgetMetric(22)} spacing={7}>
          {[ordinalBadge(target.id, ordinal), ...identityText(target), <Space width="fill" />]}
        </Row>
        <Row width="fill" height={widgetMetric(BAR_VIEW_HEIGHT)} spacing={4}>
          {[
            vitalStack(target.id, "hpLabel", "hpBars", "fill", 9),
            vitalStack(target.id, "manaLabel", "manaBars", "fill", 9),
            vitalStack(target.id, "moveLabel", "moveBars", "fill", 9),
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
      background="rgba(20,29,61,0.46)"
    >
      <Row width="fill" height="fill" padding={4} spacing={8}>
        {[
          ordinalBadge(target.id, ordinal),
          <Row width={widgetMetric(WIDE_IDENTITY_WIDTH)} height="fill" spacing={7}>
            {[...identityText(target), <Space width="fill" />]}
          </Row>,
          vitalStack(target.id, "hpLabel", "hpBars", widgetMetric(WIDE_VITAL_WIDTH), 10),
          vitalStack(target.id, "manaLabel", "manaBars", widgetMetric(WIDE_VITAL_WIDTH), 10),
          vitalStack(target.id, "moveLabel", "moveBars", widgetMetric(WIDE_VITAL_WIDTH), 10),
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
  return widgetMetric(4 + Math.max(1, sessionCount) * (playerHeight() + 2));
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
        <Column width="fill" height="fill" padding={2} spacing={2}>
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
