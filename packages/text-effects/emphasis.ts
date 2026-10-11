import emphasisShader from "./emphasis.wgsl";
import { component, range } from "./_shared.ts";
import type { EmphasisProps } from "./types.ts";

const peak = (props: EmphasisProps) => range(props.peak ?? 3, "peak", 1, 8);
export const emphasis = component<EmphasisProps>({ shader: emphasisShader, colors: ["#7192a8", "#e6f2ff", "#ffffff"], outset: 400,
        duration: 2400, replace: true, pane: true, fadeIn: 0, fadeOut: 0,
        // Intensity and scale are validated before captureScale is read; peak is validated here.
        captureScale: props => Math.min(8, 1 + peak(props) * (props.intensity ?? 1) * (props.scale ?? 1)),
    }, props => {
        const anchor = props.anchor ?? "center";
        if (!["start", "center", "end"].includes(anchor)) throw new TypeError("emphasis anchor must be start, center or end");
        if (props.fitToPane !== undefined && typeof props.fitToPane !== "boolean") throw new TypeError("emphasis fitToPane must be boolean");
        return { peak: peak(props), yaw: range(props.yaw ?? 0.35, "yaw", -1, 1),
            weight: range(props.weight ?? 0.5, "weight", 0, 2), pivot: anchor === "start" ? 0 : anchor === "end" ? 1 : 0.5,
            fit: props.fitToPane === false ? 0 : 1 };
    });
export default emphasis;
