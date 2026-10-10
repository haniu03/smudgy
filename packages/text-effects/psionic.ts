import shader from "./pressure-ink.wgsl";
import { amplitude, component } from "./_shared.ts";
import type { MotionProps } from "./types.ts";

/** An invisible moving pressure compresses and shears the shaped letters. */
export const psionic = component<MotionProps>({ shader,
    colors: ["#425a7b", "#add1ef", "#ffffff"], outset: 12, duration: 2400,
    replace: true, fadeIn: 0, fadeOut: 0, captureScale: () => 2 },
    props => ({ variant: 1, amplitude: amplitude(props) }));
export default psionic;
