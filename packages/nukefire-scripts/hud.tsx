// =============================================================================
//  Vitals HUD — a compact strip on the main pane
// =============================================================================
//  HP / Mana / Move bars are bound straight to the GMCP tree, so
//  they repaint on every Char.Vitals without a handler or remount. The only
//  structural change is the opponent block, which appears while Char.Vitals
//  carries an `opponent` and vanishes when combat ends — that transition is
//  the one thing that remounts the widget.

import { createState, getSessions, session, type Binding } from "smudgy:core";
import { focus as inputFocus } from "smudgy:events/input";
import { created, destroyed } from "smudgy:events/sessions";
import {
  Canvas,
  Column,
  Container,
  ProgressBar,
  Row,
  Space,
  Stack,
  Text,
  createWidget,
  removeWidget,
  type CanvasShape,
} from "smudgy:widgets";
import {
  nukefire,
  watchMessage,
  type CharStatus,
} from "smudgy://kapusniak/nukefire-gmcp";
import { widgetMetric, widgetTextSize } from "./config.ts";
import { UI, fmtNum, themeBackground } from "./theme.ts";

const WIDGET = "nf-hud";
const MINI_WIDGET = "nf-mini-hud";

interface OrdinalBadgeStyle {
  scene: CanvasShape[];
  text: string;
}

function ordinalBadgeStyle(active: boolean): OrdinalBadgeStyle {
  return {
    scene: [{
      kind: "rect",
      x: 0.5,
      y: 0.5,
      width: 29,
      height: 21,
      rx: 7,
      fill: active ? "rgba(252, 191, 73, 0.13)" : "rgba(255, 255, 255, 0.035)",
      stroke: {
        color: active ? UI.gold : "rgba(110, 127, 150, 0.55)",
        width: 1,
      },
    }],
    text: active ? UI.gold : UI.dim,
  };
}

const sessionOrdinal = createState<number>("sessionOrdinal");
const badgeStyle = createState<OrdinalBadgeStyle>("ordinalBadgeStyle");
badgeStyle.set(ordinalBadgeStyle(session.input.focused));

inputFocus.on(({ focused }) => badgeStyle.set(ordinalBadgeStyle(focused)));

function updateSessionOrdinal(): void {
  const index = getSessions().findIndex((candidate) => candidate.id === session.id);
  sessionOrdinal.set(index < 0 ? 1 : index + 1);
}

function scheduleOrdinalUpdate(): void {
  setTimeout(updateSessionOrdinal, 100);
}

created.on(scheduleOrdinalUpdate);
destroyed.on(scheduleOrdinalUpdate);
updateSessionOrdinal();

interface HudMeta {
  name: string;
  className: string;
  level: string;
  details: string;
  who: string;
  gold: string;
  tnl: string;
}

/** Formatted Char.Status bits (bindings are lookups, so commas are added here). */
export const hudMeta = createState<HudMeta>("hudMeta");
const profileName = session.profile.name?.trim() || `Session ${session.id}`;
hudMeta.set({
  name: profileName,
  className: "",
  level: "",
  details: "",
  who: profileName,
  gold: "",
  tnl: "",
});

function updateStatus(s: Readonly<CharStatus> | undefined): void {
  const name = s?.name?.trim() || profileName;
  const details = s ? `${s.class} · level ${s.level} · ${fmtNum(s.tnl)} XP TNL` : "";
  hudMeta.set({
    name,
    className: s?.class ?? "",
    level: s ? String(s.level) : "",
    details,
    who: details ? `${name} · ${details}` : name,
    gold: s ? `${fmtNum(s.gold)}g (${fmtNum(s.bank)} bank)` : "",
    tnl: s ? `${fmtNum(s.tnl)} XP TNL` : "",
  });
}

watchMessage("Char.Status", updateStatus);
// State watches are write-triggered rather than replaying retained state.
// Seed the HUD immediately when scripts reload after Char.Status arrived.
updateStatus(nukefire.value?.Char?.Status);

/** Bind a numeric GMCP path for a ProgressBar (deep tree paths type as
 *  `unknown` past the optional levels, so narrow them here). */
function numBind(path: string, fallback: number): Binding<number> {
  return nukefire.bind(path, { fallback }) as Binding<number>;
}

function inlineVital(label: string, color: string, cur: string, max: string) {
  return (
    <Row width="fill" spacing={4}>
      <Text size={widgetTextSize(11)} color={color}>{label}</Text>
      <ProgressBar
        width="fill"
        height={widgetMetric(12)}
        color={color}
        background="rgba(255,255,255,0.12)"
        value={numBind(cur, 0)}
        max={numBind(max, 100)}
      />
      <Text size={widgetTextSize(11)} color={UI.bright}>
        {nukefire.bind(cur, { fallback: 0 })}
        {"/"}
        {nukefire.bind(max, { fallback: 0 })}
      </Text>
    </Row>
  );
}

function ordinalBadge() {
  return (
    <Stack width={widgetMetric(30)} height={widgetMetric(22)}>
      <Canvas
        width="fill"
        height="fill"
        view_box={[0, 0, 30, 22]}
        fit="fill"
        scene={badgeStyle.bind("scene")}
      />
      <Container width="fill" height="fill" align_x="center" align_y="top">
        <Text size={widgetTextSize(18)} color={badgeStyle.bind("text")}>{sessionOrdinal.bind()}</Text>
      </Container>
    </Stack>
  );
}

function inlineOpponent() {
  return (
    <Row width="fill" spacing={4}>
      <Text size={widgetTextSize(11)} color={UI.danger}>
        {"⚔ "}
        {nukefire.bind("Char.Vitals.opponent.name", { fallback: "opponent" })}
      </Text>
      <ProgressBar
        width="fill"
        height={widgetMetric(12)}
        color={UI.danger}
        background="rgba(160,40,40,0.3)"
        value={numBind("Char.Vitals.opponent.hp", 0)}
        max={numBind("Char.Vitals.opponent.mhp", 100)}
      />
    </Row>
  );
}

function themedDetails() {
  return (
    <Row spacing={8}>
      <Text size={widgetTextSize(11)} color={UI.teal}>{hudMeta.bind("className")}</Text>
      <Text size={widgetTextSize(11)} color={UI.faint}>·</Text>
      <Text size={widgetTextSize(11)} color={UI.gold}>
        level {hudMeta.bind("level")}
      </Text>
    </Row>
  );
}

/** Height reserved by the HUD on the main pane. */
export const HUD_HEIGHT = widgetMetric(56);
const MINI_HUD_HEIGHT = widgetMetric(56);

let fighting = false;
let shown = false;

function mount(): void {
  createWidget(
    WIDGET,
    <Container width="fill" height={HUD_HEIGHT} background={themeBackground.bind()}>
      <Column width="fill" height="fill" padding={6} spacing={2}>
        <Row width="fill" height={widgetMetric(24)} spacing={8}>
          {[
            ordinalBadge(),
            <Text size={widgetTextSize(18)} color={UI.gold}>{hudMeta.bind("name")}</Text>,
            inlineVital("HP", UI.hp, "Char.Vitals.hp", "Char.Vitals.mhp"),
            inlineVital("MN", UI.mana, "Char.Vitals.mana", "Char.Vitals.mmana"),
            inlineVital("MV", UI.move, "Char.Vitals.move", "Char.Vitals.mmove"),
            ...(fighting ? [inlineOpponent()] : []),
          ]}
        </Row>
        <Row width="fill" height={widgetMetric(16)} spacing={8}>
          {themedDetails()}
          <Space width="fill" />
          <Text size={widgetTextSize(11)} color={UI.good}>{hudMeta.bind("tnl")}</Text>
        </Row>
      </Column>
    </Container>,
  );
}

function mountMini(): void {
  createWidget(
    MINI_WIDGET,
    <Container width="fill" height={MINI_HUD_HEIGHT} background={themeBackground.bind()}>
      <Column width="fill" height="fill" padding={6} spacing={2}>
        <Row width="fill" height={widgetMetric(24)} spacing={8}>
          {[
            ordinalBadge(),
            <Text size={widgetTextSize(18)} color={UI.gold}>{hudMeta.bind("name")}</Text>,
            inlineVital("HP", UI.hp, "Char.Vitals.hp", "Char.Vitals.mhp"),
            inlineVital("MN", UI.mana, "Char.Vitals.mana", "Char.Vitals.mmana"),
            inlineVital("MV", UI.move, "Char.Vitals.move", "Char.Vitals.mmove"),
          ]}
        </Row>
        <Row width="fill" height={widgetMetric(16)} spacing={8}>
          {themedDetails()}
          <Space width="fill" />
          <Text size={widgetTextSize(11)} color={UI.good}>{hudMeta.bind("tnl")}</Text>
        </Row>
      </Column>
    </Container>,
  );
}

watchMessage("Char.Vitals", (v) => {
  const now = v?.opponent !== undefined;
  if (now !== fighting) {
    fighting = now;
    if (shown) mount();
  }
});

export function open(): void {
  shown = true;
  mount();
}

export function close(): void {
  shown = false;
  removeWidget(WIDGET);
}

/** A shallow identity/vitals strip used on docked secondary terminals. */
export function openMini(): void {
  mountMini();
}

export function closeMini(): void {
  removeWidget(MINI_WIDGET);
}
