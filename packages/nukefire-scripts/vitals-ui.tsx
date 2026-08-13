import {
  Canvas,
  Column,
  Container,
  Row,
  Space,
  Stack,
  Text,
  type Bindable,
  type CanvasShape,
  type Children,
} from "smudgy:widgets";
import { widgetMetric, widgetTextSize } from "./config.ts";
import { UI } from "./theme.ts";

const BAR_VIEW_WIDTH = 100;
export const VITAL_BAR_HEIGHT = 16;
const BAR_CAP_WIDTH = 10;
const BAR_CAP_OVERLAP = 1;
const BAR_FILL_INSET = 0;
const BAR_TWEEN_MS = 320;

export interface BarSlices {
  start: CanvasShape[];
  middle: CanvasShape[];
  end: CanvasShape[];
}

interface BarSliceBindings {
  start: Bindable<CanvasShape[]>;
  middle: Bindable<CanvasShape[]>;
  end: Bindable<CanvasShape[]>;
}

export interface VitalBarSpec {
  key: string;
  current: number;
  maximum: number;
  gradient: readonly [string, string, string];
}

type GradientFill = {
  gradient: {
    from: [number, number];
    to: [number, number];
    stops: [number, string][];
  };
};

function gradient(
  from: [number, number],
  to: [number, number],
  stops: readonly [string, string, string],
): GradientFill {
  return {
    gradient: {
      from,
      to,
      stops: [[0, stops[0]], [0.55, stops[1]], [1, stops[2]]],
    },
  };
}

export function vitalRatio(current: number, maximum: number): number {
  return Math.min(1, Math.max(0, current / Math.max(1, maximum)));
}

export function vitalReadoutColor(current: number, maximum: number): string {
  const remaining = vitalRatio(current, maximum);
  if (remaining <= 0.2) return UI.danger;
  if (remaining <= 0.45) return UI.warning;
  return UI.bright;
}

/** The shared fixed-cap/stretch-center bar scene used by every NukeFire vitals header. */
export function buildVitalBarSlices(
  sceneId: string,
  spec: VitalBarSpec,
  oldRatio: number | undefined,
): BarSlices {
  const nextRatio = vitalRatio(spec.current, spec.maximum);
  const fillWidth = BAR_VIEW_WIDTH * nextRatio;
  const fromWidth = BAR_VIEW_WIDTH * (oldRatio ?? nextRatio);
  const shouldTween = oldRatio !== undefined && Math.abs(oldRatio - nextRatio) > 0.0001;
  const widthTween = shouldTween
    ? { width: { from: fromWidth, to: fillWidth, duration: BAR_TWEEN_MS, ease: "out" as const } }
    : undefined;
  const y = 0;
  const capDiameter = BAR_CAP_WIDTH * 2;
  const glossHeight = 6;
  const shapeId = `${sceneId}-${spec.key}`;
  const trackStops = ["#0f162b", "#060a12", "#11182c"] as const;
  const track = gradient([0, y], [BAR_VIEW_WIDTH, y], trackStops);
  const gloss = gradient(
    [0, y + 1],
    [0, y + 1 + glossHeight],
    ["rgba(255,255,255,0.40)", "rgba(255,255,255,0.13)", "rgba(255,255,255,0.01)"],
  );
  const depth = gradient(
    [0, y + VITAL_BAR_HEIGHT - 5],
    [0, y + VITAL_BAR_HEIGHT],
    ["rgba(0,0,0,0)", "rgba(0,0,0,0.14)", "rgba(0,0,0,0.38)"],
  );
  const cap = (side: "start" | "end", filled: boolean): CanvasShape[] => {
    const x = side === "start" ? 0.5 : -(BAR_CAP_WIDTH + 0.5);
    const stopIndex = side === "start" ? 0 : 2;
    return [
      {
        kind: "rect",
        x,
        y,
        width: capDiameter,
        height: VITAL_BAR_HEIGHT,
        rx: VITAL_BAR_HEIGHT / 2,
        fill: trackStops[stopIndex],
      },
      ...(filled
        ? [{
          kind: "rect" as const,
          x: x + BAR_FILL_INSET,
          y: y + BAR_FILL_INSET,
          width: capDiameter - 2 * BAR_FILL_INSET,
          height: VITAL_BAR_HEIGHT - 2 * BAR_FILL_INSET,
          rx: (VITAL_BAR_HEIGHT - 2 * BAR_FILL_INSET) / 2,
          fill: spec.gradient[stopIndex],
        }, {
          kind: "rect" as const,
          x: x + BAR_FILL_INSET + 0.5,
          y: y + BAR_FILL_INSET + 0.5,
          width: capDiameter - 2 * (BAR_FILL_INSET + 0.5),
          height: glossHeight,
          rx: glossHeight,
          fill: gloss,
          opacity: 0.72,
        }, {
          kind: "rect" as const,
          x: x + BAR_FILL_INSET,
          y: y + BAR_FILL_INSET,
          width: capDiameter - 2 * BAR_FILL_INSET,
          height: VITAL_BAR_HEIGHT - 2 * BAR_FILL_INSET,
          rx: (VITAL_BAR_HEIGHT - 2 * BAR_FILL_INSET) / 2,
          fill: depth,
        }]
        : []),
    ];
  };

  return {
    start: cap("start", nextRatio > 0),
    middle: [
      {
        kind: "rect",
        x: -1,
        y,
        width: BAR_VIEW_WIDTH + 2,
        height: VITAL_BAR_HEIGHT,
        fill: track,
      },
      {
        kind: "rect",
        id: `${shapeId}-fill`,
        x: 0,
        y: y + BAR_FILL_INSET,
        width: fillWidth,
        height: VITAL_BAR_HEIGHT - 2 * BAR_FILL_INSET,
        fill: gradient([0, y], [BAR_VIEW_WIDTH, y], spec.gradient),
        animate: widthTween,
      },
      {
        kind: "rect",
        id: `${shapeId}-gloss`,
        x: 0,
        y: y + BAR_FILL_INSET + 0.5,
        width: fillWidth,
        height: glossHeight,
        fill: gloss,
        opacity: 0.72,
        animate: shouldTween
          ? {
            width: {
              from: fromWidth,
              to: fillWidth,
              duration: BAR_TWEEN_MS,
              ease: "out",
            },
          }
          : undefined,
      },
      {
        kind: "rect",
        id: `${shapeId}-depth`,
        x: 0,
        y: y + BAR_FILL_INSET,
        width: fillWidth,
        height: VITAL_BAR_HEIGHT - 2 * BAR_FILL_INSET,
        fill: depth,
        animate: widthTween,
      },
      ...(nextRatio > 0.01 && nextRatio < 0.9999
        ? [{
          kind: "rect" as const,
          id: `${shapeId}-edge`,
          x: Math.max(0, fillWidth - 0.5),
          y,
          width: 0.5,
          height: VITAL_BAR_HEIGHT,
          fill: spec.gradient[2],
          opacity: 0.78,
          animate: shouldTween
            ? {
              x: {
                from: Math.max(0, fromWidth - 0.5),
                to: Math.max(0, fillWidth - 0.5),
                duration: BAR_TWEEN_MS,
                ease: "out" as const,
              },
            }
            : undefined,
        }]
        : []),
    ],
    end: cap("end", nextRatio >= 0.9999),
  };
}

/** Render shared bar slices without stretching their rounded endcaps. */
export function vitalBar(slices: BarSliceBindings, width: number | "fill" = "fill") {
  const capWidth = widgetMetric(BAR_CAP_WIDTH);
  const centerInset = widgetMetric(BAR_CAP_WIDTH - BAR_CAP_OVERLAP);
  return (
    <Stack width={width} height={widgetMetric(VITAL_BAR_HEIGHT)}>
      {[
        <Row width="fill" height="fill" spacing={0}>
          {[
            <Space width={centerInset} />,
            <Canvas
              width="fill"
              height="fill"
              view_box={[0, 0, BAR_VIEW_WIDTH, VITAL_BAR_HEIGHT]}
              fit="fill"
              scene={slices.middle}
            />,
            <Space width={centerInset} />,
          ]}
        </Row>,
        <Row width="fill" height="fill" spacing={0}>
          {[
            <Canvas
              width={capWidth}
              height="fill"
              view_box={[0, 0, BAR_CAP_WIDTH, VITAL_BAR_HEIGHT]}
              fit="contain"
              scene={slices.start}
            />,
            <Space width="fill" />,
            <Canvas
              width={capWidth}
              height="fill"
              view_box={[0, 0, BAR_CAP_WIDTH, VITAL_BAR_HEIGHT]}
              fit="contain"
              scene={slices.end}
            />,
          ]}
        </Row>,
      ]}
    </Stack>
  );
}

export function compactVital(
  label: string,
  value: Children,
  valueColor: Bindable<string>,
  slices: BarSliceBindings,
  color: string,
) {
  return (
    <Stack width="fill" height={widgetMetric(18)}>
      <Container width="fill" height="fill" align_y="center">{vitalBar(slices)}</Container>
      <Container width="fill" height="fill" align_x="center" align_y="center">
        <Row spacing={widgetMetric(4)}>
          {[vitalLabel(label, color, 8), vitalValue(value, 9, valueColor)]}
        </Row>
      </Container>
    </Stack>
  );
}

export function wideVital(
  label: string,
  value: Children,
  valueColor: Bindable<string>,
  slices: BarSliceBindings,
  color: string,
) {
  return (
    <Row width="fill" height="fill" spacing={widgetMetric(5)}>
      {[
        <Column width={widgetMetric(62)} height="fill" spacing={0}>
          {[
            <Container width="fill" height={widgetMetric(13)} align_x="right" align_y="center">
              {vitalLabel(label, color)}
            </Container>,
            <Container width="fill" height={widgetMetric(13)} align_x="right" align_y="center">
              {vitalValue(value, 10, valueColor)}
            </Container>,
          ]}
        </Column>,
        <Container width="fill" height="fill" align_y="bottom">{vitalBar(slices)}</Container>,
      ]}
    </Row>
  );
}

/** Shared active-session marker used by both single- and multi-character HUDs. */
export function sessionBadge(
  ordinal: Children,
  scene: Bindable<CanvasShape[]>,
  color: Bindable<string>,
) {
  return (
    <Stack width={widgetMetric(30)} height={widgetMetric(22)}>
      <Canvas
        width="fill"
        height="fill"
        view_box={[0, 0, 30, 22]}
        fit="contain"
        scene={scene}
      />
      <Container width="fill" height="fill" align_x="center" align_y="center">
        <Text size={widgetTextSize(14)} color={color}>{ordinal}</Text>
      </Container>
    </Stack>
  );
}

export function characterName(
  value: Children,
  size = 15,
  color: Bindable<string> = UI.gold,
) {
  return <Text size={widgetTextSize(size)} color={color}>{value}</Text>;
}

/** Compact, color-separated identity metadata for rapid character scanning. */
export function classAndLevel(
  className: Children,
  levelLabel: Children,
  size = 10,
  separator: Children = "/",
) {
  return (
    <Row spacing={widgetMetric(5)}>
      <Text size={widgetTextSize(size)} color={UI.teal}>{className}</Text>
      <Text size={widgetTextSize(Math.max(8, size - 1))} color={UI.faint}>{separator}</Text>
      <Text size={widgetTextSize(size)} color={UI.warning}>{levelLabel}</Text>
    </Row>
  );
}

export function vitalLabel(label: Children, color: string, size = 9) {
  return <Text size={widgetTextSize(size)} color={color}>{label}</Text>;
}

export function vitalValue(
  value: Children,
  size = 10,
  color: Bindable<string> = UI.bright,
) {
  return <Text size={widgetTextSize(size)} color={color}>{value}</Text>;
}
