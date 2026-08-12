// =============================================================================
//  Affects pane — live effects with local countdowns, plus a target scanner
// =============================================================================
//  NukeFire.Affects entries carry `remaining` seconds relative to the
//  payload's `server_time`; the pane counts them down locally (a 5s ticker
//  remounts while timed effects exist) and re-syncs on every push. The
//  summary chips are bindings, so they track the payload with no remount.
//
//  The Target section shows Char.TargetAffects — request it mid-fight with
//  the Scan button (the server only answers while fighting).

import { createTimer, gmcp, session } from "smudgy:core";
import {
  Button,
  Column,
  Row,
  Scrollable,
  Space,
  Text,
  Tooltip,
  createWidget,
} from "smudgy:widgets";
import {
  nukefire,
  requestTargetAffects,
  watchMessage,
  type CharTargetAffects,
  type NukeFireAffects,
  type NukeFireEffect,
} from "smudgy://kapusniak/nukefire-gmcp";
import { widgetTextSize } from "./config.ts";
import { UI, fmtDuration } from "./theme.ts";

const PANE = "Affects";

let affects: Readonly<NukeFireAffects> | undefined;
let affectsReceivedAt = 0; // Date.now() when the payload landed
let target: Readonly<CharTargetAffects> | undefined;
let shown = false;

watchMessage("NukeFire.Affects", (payload) => {
  affects = payload;
  affectsReceivedAt = Date.now();
  if (shown) mount();
});

watchMessage("Char.TargetAffects", (payload) => {
  target = payload;
  if (shown) mount();
});

// Local countdown: redraw every 5s while something is actually ticking.
createTimer({ intervalMs: 5000, repeat: true }, () => {
  if (shown && (affects?.timed_count ?? 0) > 0) mount();
});

function remainingNow(effect: NukeFireEffect): number {
  const elapsed = (Date.now() - affectsReceivedAt) / 1000;
  return effect.remaining - elapsed;
}

function remainingLabel(effect: NukeFireEffect) {
  if (effect.permanent) {
    return <Text size={widgetTextSize(10)} color={UI.faint}>perm</Text>;
  }
  const left = remainingNow(effect);
  if (left <= 0) {
    return <Text size={widgetTextSize(10)} color={UI.danger}>expiring…</Text>;
  }
  return (
    <Text size={widgetTextSize(11)} color={left < 60 ? UI.warning : UI.gold}>{fmtDuration(left)}</Text>
  );
}

function effectRows(effects: readonly NukeFireEffect[]) {
  return effects.map((e) => {
    const grants = typeof e.grants === "string" ? e.grants : "";
    return (
      <Column spacing={0}>
        {[
          <Row spacing={6}>
            <Text size={widgetTextSize(12)} color={UI.bright}>{e.spell}</Text>
            {grants !== "" && <Text size={widgetTextSize(9)} color="#9d8fe0">grants {grants}</Text>}
            <Space width="fill" />
            {remainingLabel(e)}
          </Row>,
          e.apply !== "NONE" && e.modifier !== 0 && (
            <Text size={widgetTextSize(10)} color={UI.dim}>
              {"  "}{e.modifier > 0 ? "+" : ""}{e.modifier} {e.apply}
            </Text>
          ),
        ]}
      </Column>
    );
  });
}

function affectsSection() {
  const children = [];
  if (!affects || affects.effects.length === 0) {
    children.push(<Text size={widgetTextSize(11)} color={UI.faint}>No visible affects.</Text>);
  } else {
    children.push(...effectRows(affects.effects));
  }
  if (affects && affects.hidden_permanent > 0) {
    children.push(
      <Text size={widgetTextSize(9)} color={UI.faint}>
        {affects.hidden_permanent} permanent equipment/implant/remort modifiers omitted
      </Text>,
    );
  }
  if (affects?.truncated) {
    children.push(<Text size={widgetTextSize(9)} color={UI.warning}>list truncated by the server</Text>);
  }
  return children;
}

function targetSection() {
  const children = [
    <Row spacing={6}>
      <Text size={widgetTextSize(12)} color={UI.danger}>Target</Text>
      <Space width="fill" />
      <Tooltip tip="ask the server for the current combat target's affects (answered while fighting)">
        <Button variant="subtle" onPress={requestTargetAffects}>
          <Text size={widgetTextSize(10)} color={UI.dim}>scan</Text>
        </Button>
      </Tooltip>
    </Row>,
  ];
  if (target?.target) {
    children.push(
      <Text size={widgetTextSize(11)} color={UI.bright}>
        {target.target.name}
        {target.target.type === "npc" ? ` (vnum ${target.target.vnum})` : ""}
      </Text>,
    );
    if (target.effects.length > 0) {
      children.push(...effectRows(target.effects));
    } else {
      children.push(<Text size={widgetTextSize(10)} color={UI.faint}>no effects on target</Text>);
    }
  } else {
    children.push(<Text size={widgetTextSize(10)} color={UI.faint}>nothing scanned</Text>);
  }
  return children;
}

function mount(): void {
  createWidget(
    "nf-affects",
    <Column width="fill" height="fill" padding={6} spacing={5}>
      <Row spacing={6}>
        <Text size={widgetTextSize(12)} color={UI.header}>Affects</Text>
        <Text size={widgetTextSize(10)} color={UI.dim}>
          {nukefire.bind("NukeFire.Affects.count", { fallback: 0 })}
          {" active · "}
          {nukefire.bind("NukeFire.Affects.timed_count", { fallback: 0 })}
          {" timed"}
        </Text>
        <Space width="fill" />
        <Button variant="subtle" onPress={() => gmcp.send("NukeFire.Affects")}>
          <Text size={widgetTextSize(10)} color={UI.dim}>refresh</Text>
        </Button>
      </Row>
      <Scrollable width="fill" height="fill">
        <Column spacing={4}>
          {[...affectsSection(), <Space height={8} />, ...targetSection()]}
        </Column>
      </Scrollable>
    </Column>,
    { pane: PANE },
  );
}

export function open(): void {
  session.mainPane.split("left", { name: PANE, width: 330, terminal: false });
  shown = true;
  mount();
}

export function close(): void {
  shown = false;
  session.panes.get(PANE)?.close();
}
