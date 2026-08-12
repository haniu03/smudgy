// =============================================================================
//  GPS Atlas pane — the destination catalog, filterable, click-to-travel
// =============================================================================
//  fetchGpsCatalog() collects the whole Begin/Page/End transfer into one list;
//  the pane's own input line filters it (name, zone, category, alias, tag —
//  press Enter to apply), and clicking a destination sets the GPS route.
//  Progress and status go through a bound state so the header text live-
//  updates during the transfer without remounting the list.

import { createState, send, session } from "smudgy:core";
import { gmcp } from "smudgy:core";
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
  fetchGpsCatalog,
  watchMessage,
  type NukeFireGpsDestination,
} from "smudgy://kapusniak/nukefire-gmcp";
import { filteredGpsDestinations } from "./atlas-model.ts";
import { widgetTextSize } from "./config.ts";
import { GPS_CLEAR, GPS_WALK, UI, gpsSet } from "./theme.ts";

const PANE = "Atlas";
const MAX_ROWS = 150;

const atlasStatus = createState<{ text: string }>("atlasStatus");
atlasStatus.set({ text: "waiting for GMCP…" });

let catalog: NukeFireGpsDestination[] = [];
let filter = "";
let fetching = false;
let fetchedOnce = false;
let fetchFailed = false;
let shown = false;

function refresh(): void {
  if (fetching) return;
  fetching = true;
  fetchFailed = false;
  atlasStatus.set({ text: "loading…" });
  fetchGpsCatalog({
    onProgress: (p) => atlasStatus.set({ text: `loading ${p.received}/${p.count}…` }),
  })
    .then((destinations) => {
      catalog = destinations;
      fetchedOnce = true;
      atlasStatus.set({ text: `${catalog.length} destinations` });
      if (shown) mount();
    })
    .catch((error: Error) => {
      fetchFailed = true;
      atlasStatus.set({ text: `failed: ${error.message}` });
      if (shown) mount(); // surfaces the Retry state
    })
    .finally(() => {
      fetching = false;
    });
}

function chooseDestination(destination: NukeFireGpsDestination): void {
  send(gpsSet(destination.index));
  send(GPS_WALK);
}

function destinationRow(d: NukeFireGpsDestination) {
  if (!d.available) {
    return (
      <Row spacing={6}>
        <Tooltip tip="currently unavailable">
          <Text size={widgetTextSize(11)} color={UI.faint}>{d.name}</Text>
        </Tooltip>
        <Text size={widgetTextSize(9)} color={UI.faint}>zone {d.zone}</Text>
      </Row>
    );
  }
  return (
    <Row spacing={6}>
      <Tooltip tip={`set GPS → ${d.name} (#${d.index})`}>
        <Button variant="link" onPress={() => chooseDestination(d)}>
          <Text size={widgetTextSize(11)} color={UI.text}>{d.name}</Text>
        </Button>
      </Tooltip>
      <Text size={widgetTextSize(9)} color={UI.faint}>zone {d.zone}</Text>
      <Text size={widgetTextSize(9)} color={UI.dim}>{d.difficulty}</Text>
    </Row>
  );
}

function listChildren() {
  const filtered = filteredGpsDestinations(catalog, filter);
  const visible = filtered.slice(0, MAX_ROWS);

  const children = [];
  let lastCategory = "";
  for (const d of visible) {
    if (d.category !== lastCategory) {
      lastCategory = d.category;
      children.push(
        <Text size={widgetTextSize(10)} color="#8888cc">{d.category.toUpperCase()}</Text>,
      );
    }
    children.push(destinationRow(d));
  }
  if (filtered.length > MAX_ROWS) {
    children.push(
      <Text size={widgetTextSize(10)} color={UI.warning}>
        …{filtered.length - MAX_ROWS} more — refine the filter below
      </Text>,
    );
  }
  if (children.length === 0) {
    children.push(
      <Text size={widgetTextSize(11)} color={UI.faint}>
        {fetchedOnce ? `nothing matches “${filter}”` : "catalog not loaded"}
      </Text>,
    );
  }
  return children;
}

watchMessage("Room.Info", () => {
  if (shown && fetchFailed && !fetching) refresh();
});

function mount(): void {
  createWidget(
    "nf-atlas",
    <Column width="fill" height="fill" padding={6} spacing={5}>
      <Row spacing={8}>
        <Text size={widgetTextSize(12)} color={UI.header}>GPS Atlas</Text>
        <Text size={widgetTextSize(10)} color={UI.dim}>{atlasStatus.bind("text")}</Text>
        {filter.trim() !== "" && <Text size={widgetTextSize(10)} color={UI.gold}>filter: {filter}</Text>}
        <Space width="fill" />
        <Button variant="subtle" onPress={refresh}>
          <Text size={widgetTextSize(10)} color={UI.dim}>{fetchedOnce ? "refresh" : "retry"}</Text>
        </Button>
        <Button variant="subtle" onPress={() => send(GPS_CLEAR)}>
          <Text size={widgetTextSize(10)} color={UI.dim}>clear GPS</Text>
        </Button>
      </Row>
      <Scrollable width="fill" height="fill">
        <Column spacing={3}>{listChildren()}</Column>
      </Scrollable>
    </Column>,
    { pane: PANE },
  );
}

export function open(): void {
  const input = {
    placeholder: "filter destinations: name, zone, category, alias… (Enter to apply)",
    onSubmit: (text: string) => {
      filter = text;
      mount();
    },
  };
  const mapPane = session.panes.get("Map");
  if (mapPane) {
    const atlasPane = mapPane.addTab({ name: PANE, terminal: false, input });
    // Also migrates the old below-Radar placement on first load of this version.
    atlasPane.groupWith(mapPane, { position: "after" });
    mapPane.select();
  } else {
    session.mainPane.split("right", {
      name: PANE,
      width: 400,
      terminal: false,
      input,
    });
  }
  shown = true;
  mount();
  if (!fetchedOnce && !fetching) {
    gmcp.onReady(refresh);
  }
}

export function close(): void {
  shown = false;
  session.panes.get(PANE)?.close();
}
