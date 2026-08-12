// =============================================================================
//  Map pane — the smudgy MapView with a room header and a live GPS strip
// =============================================================================
//  Everything in this pane is fed by bindings (room name/area from Room.Info,
//  the GPS line from a small derived state), so the widget mounts once and
//  never rebuilds — the MapView keeps its zoom and pan across room changes.

import { createState, send, session } from "smudgy:core";
import { Button, Column, MapView, Row, Space, Text, createWidget } from "smudgy:widgets";
import { nukefire, watchMessage } from "smudgy://kapusniak/nukefire-gmcp";
import { widgetTextSize } from "./config.ts";
import { GPS_CLEAR, UI } from "./theme.ts";

const PANE = "Map";

interface GpsView {
  line: string;
  color: string;
}

const gpsView = createState<GpsView>("gpsView");
gpsView.set({ line: "no route set", color: UI.faint });

watchMessage("Char.GPS", (gps) => {
  if (gps?.active) {
    gpsView.set({
      line: `→ ${gps.destination} · ${gps.steps} steps · next: ${gps.next || "?"}`,
      color: UI.gold,
    });
  } else {
    gpsView.set({ line: "no route set", color: UI.faint });
  }
});

function mount(): void {
  createWidget(
    "nf-map",
    <Column width="fill" height="fill" padding={6} spacing={6}>
      <Row spacing={8}>
        <Text size={widgetTextSize(14)} color={UI.bright}>
          {nukefire.bind("Room.Info.name", { fallback: "NukeFire" })}
        </Text>
        <Space width="fill" />
        <Text size={widgetTextSize(11)} color={UI.dim}>
          {nukefire.bind("Room.Info.area", { fallback: "" })}
        </Text>
      </Row>
      <MapView />
      <Row spacing={8}>
        <Text size={widgetTextSize(11)} color={UI.gold}>GPS</Text>
        <Text size={widgetTextSize(11)} color={gpsView.bind("color")}>{gpsView.bind("line")}</Text>
        <Space width="fill" />
        <Button variant="subtle" onPress={() => send(GPS_CLEAR)}>
          <Text size={widgetTextSize(10)} color={UI.dim}>clear</Text>
        </Button>
      </Row>
    </Column>,
    { pane: PANE },
  );
}

export function open(): void {
  session.mainPane.split("right", { name: PANE, width: 400, terminal: false });
  mount();
}

export function close(): void {
  session.panes.get(PANE)?.close();
}
