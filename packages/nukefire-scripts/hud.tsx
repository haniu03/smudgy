// =============================================================================
//  Vitals HUD — a compact strip on the main pane
// =============================================================================
//  HP / Mana / Move updates rebuild bound scenes from the same shared bar
//  renderer as the aggregate tabbed-session display. The only structural
//  change is the wide header's opponent block, which appears while
//  Char.Vitals carries an `opponent`; that transition remounts the widget.

import { createState, getSessions, session } from "smudgy:core";
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
import { widgetMetric } from "./config.ts";
import { UI, fmtNum, themeBackground } from "./theme.ts";
import {
  type BarSlices,
  buildVitalBarSlices,
  characterName,
  classAndLevel,
  compactVital,
  sessionBadge,
  vitalRatio,
  vitalReadoutColor,
  wideVital,
} from "./vitals-ui.tsx";

const WIDGET = "nf-hud";
const MINI_WIDGET = "nf-mini-hud";

interface OrdinalBadgeStyle {
  scene: CanvasShape[];
  text: string;
  name: string;
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
    name: active ? UI.gold : "#d8e0e8",
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

function ordinalBadge() {
  return sessionBadge(sessionOrdinal.bind(), badgeStyle.bind("scene"), badgeStyle.bind("text"));
}

type HudBarKey = "hpBar" | "manaBar" | "moveBar" | "opponentBar";

interface HudVitalsDisplay {
  hpValue: string;
  manaValue: string;
  moveValue: string;
  opponentValue: string;
  hpValueColor: string;
  manaValueColor: string;
  moveValueColor: string;
  opponentValueColor: string;
  hpBar: BarSlices;
  manaBar: BarSlices;
  moveBar: BarSlices;
  opponentBar: BarSlices;
}

const hudVitals = createState<HudVitalsDisplay>("hudVitalsDisplay");
const previousRatios = new Map<string, number>();

function localBar(
  key: "hp" | "mana" | "move" | "opponent",
  current: number,
  maximum: number,
  gradient: readonly [string, string, string],
): BarSlices {
  const oldRatio = previousRatios.get(key);
  const nextRatio = vitalRatio(current, maximum);
  previousRatios.set(key, nextRatio);
  return buildVitalBarSlices(
    `hud-${session.id}`,
    { key, current, maximum, gradient },
    oldRatio,
  );
}

function updateVitals(value: Readonly<CharVitals> | undefined): void {
  const hp = value?.hp ?? 0;
  const mhp = value?.mhp ?? 1;
  const mana = value?.mana ?? 0;
  const mmana = value?.mmana ?? 1;
  const move = value?.move ?? 0;
  const mmove = value?.mmove ?? 1;
  const opponentHp = value?.opponent?.hp ?? 0;
  const opponentMhp = value?.opponent?.mhp ?? 1;

  hudVitals.set({
    hpValue: `${hp} / ${mhp}`,
    manaValue: `${mana} / ${mmana}`,
    moveValue: `${move} / ${mmove}`,
    opponentValue: `${opponentHp} / ${opponentMhp}`,
    hpValueColor: vitalReadoutColor(hp, mhp),
    manaValueColor: vitalReadoutColor(mana, mmana),
    moveValueColor: vitalReadoutColor(move, mmove),
    opponentValueColor: vitalReadoutColor(opponentHp, opponentMhp),
    hpBar: localBar("hp", hp, mhp, ["#71131d", UI.hp, "#ff6672"]),
    manaBar: localBar("mana", mana, mmana, ["#173a63", UI.mana, "#65b7e6"]),
    moveBar: localBar("move", move, mmove, ["#155548", UI.move, "#55c5a5"]),
    opponentBar: localBar("opponent", opponentHp, opponentMhp, ["#71131d", UI.hp, "#ff6672"]),
  });
}

function barBindings(key: HudBarKey) {
  return {
    start: hudVitals.bind(`${key}.start`, { fallback: [] }),
    middle: hudVitals.bind(`${key}.middle`, { fallback: [] }),
    end: hudVitals.bind(`${key}.end`, { fallback: [] }),
  };
}

function localCompactVital(
  label: "HP" | "MN" | "MV",
  valueKey: "hpValue" | "manaValue" | "moveValue",
  colorKey: "hpValueColor" | "manaValueColor" | "moveValueColor",
  barKey: Exclude<HudBarKey, "opponentBar">,
  color: string,
) {
  return compactVital(
    label,
    hudVitals.bind(valueKey, { fallback: "—" }),
    hudVitals.bind(colorKey, { fallback: UI.bright }),
    barBindings(barKey),
    color,
  );
}

function localWideVital(
  label: "HP" | "MN" | "MV" | "OP",
  valueKey: "hpValue" | "manaValue" | "moveValue" | "opponentValue",
  colorKey: "hpValueColor" | "manaValueColor" | "moveValueColor" | "opponentValueColor",
  barKey: HudBarKey,
  color: string,
) {
  return wideVital(
    label,
    hudVitals.bind(valueKey, { fallback: "—" }),
    hudVitals.bind(colorKey, { fallback: UI.bright }),
    barBindings(barKey),
    color,
  );
}

function identityText() {
  return [
    characterName(hudMeta.bind("name"), 13, badgeStyle.bind("name")),
    classAndLevel(hudMeta.bind("className"), ["LV ", hudMeta.bind("level")], 10),
  ];
}

/** Height reserved by the HUD on the main pane. */
export const HUD_HEIGHT = widgetMetric(30);
const MINI_HUD_HEIGHT = widgetMetric(52);
const WIDE_IDENTITY_WIDTH = 125;
const WIDE_IDENTITY_GAP = 4;

let fighting = nukefire.value?.Char?.Vitals?.opponent !== undefined;
let shown = false;

function mount(): void {
  createWidget(
    WIDGET,
    <Container width="fill" height={HUD_HEIGHT} background={themeBackground.bind()}>
      <Row width="fill" height="fill" padding={0} spacing={widgetMetric(WIDE_IDENTITY_GAP)}>
        {[
          ordinalBadge(),
          <Column width={widgetMetric(WIDE_IDENTITY_WIDTH)} height="fill" spacing={0}>
            {identityText()}
          </Column>,
          <Row width="fill" height="fill" spacing={widgetMetric(14)}>
            {[
              localWideVital("HP", "hpValue", "hpValueColor", "hpBar", UI.hp),
              localWideVital("MN", "manaValue", "manaValueColor", "manaBar", UI.mana),
              localWideVital("MV", "moveValue", "moveValueColor", "moveBar", UI.move),
              ...(fighting
                ? [localWideVital(
                  "OP",
                  "opponentValue",
                  "opponentValueColor",
                  "opponentBar",
                  UI.danger,
                )]
                : []),
            ]}
          </Row>,
        ]}
      </Row>
    </Container>,
  );
}

function mountMini(): void {
  createWidget(
    MINI_WIDGET,
    <Container width="fill" height={MINI_HUD_HEIGHT} background={themeBackground.bind()}>
      <Column width="fill" height="fill" padding={3} spacing={1}>
        <Row width="fill" height={widgetMetric(22)} spacing={7}>
          {[ordinalBadge(), ...identityText(), <Space width="fill" />]}
        </Row>
        <Row width="fill" height={widgetMetric(18)} spacing={4}>
          {[
            localCompactVital("HP", "hpValue", "hpValueColor", "hpBar", UI.hp),
            localCompactVital("MN", "manaValue", "manaValueColor", "manaBar", UI.mana),
            localCompactVital("MV", "moveValue", "moveValueColor", "moveBar", UI.move),
          ]}
        </Row>
      </Column>
    </Container>,
  );
}

watchMessage("Char.Vitals", (v) => {
  updateVitals(v);
  const now = v?.opponent !== undefined;
  if (now !== fighting) {
    fighting = now;
    if (shown) mount();
  }
});
updateVitals(nukefire.value?.Char?.Vitals);

export function open(): void {
  shown = true;
  mount();
}

export function close(): void {
  shown = false;
  removeWidget(WIDGET);
}

/** The compact identity/vitals header used on docked secondary terminals. */
export function openMini(): void {
  mountMini();
}

export function closeMini(): void {
  removeWidget(MINI_WIDGET);
}
