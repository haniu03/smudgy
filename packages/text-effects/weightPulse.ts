import shader from "./pressure-ink.wgsl";
import { amplitude, component } from "./_shared.ts";
import type { MotionProps } from "./types.ts";

/** A soft reading-order wave adds ink weight, with fixed spacing and baseline. */
export const weightPulse = component<MotionProps>({ shader,
    colors: ["#425a7b", "#add1ef", "#ffffff"], outset: 6, duration: 2400,
    replace: true, fadeIn: 0, fadeOut: 0, captureScale: () => 2 },
    props => ({ variant: 0, amplitude: amplitude(props) }));
export default weightPulse;
