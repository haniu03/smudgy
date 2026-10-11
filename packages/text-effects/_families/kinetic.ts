import kineticShader from "../kinetic.wgsl";
import { amplitude, component, transitionMode } from "../_shared.ts";
import type { TransitionMode, TransitionProps, MotionProps } from "../types.ts";

export const kinetic = (variant: number, mode: TransitionMode) => component<TransitionProps>({ shader: kineticShader,
    colors: ["#7192a8", "#e6f2ff", "#ffffff"], outset: 400, duration: 2400, replace: true,
    pane: true, fadeIn: 0, fadeOut: 0, captureScale: () => 2,
}, props => ({ variant, amplitude: amplitude(props), mode: transitionMode(props, mode) }));
export const gesture = (variant: number) => {
    const play = kinetic(variant, "cycle");
    return (props: MotionProps = {}, children = props.children) => play({ ...props, mode: "cycle" }, children);
};
