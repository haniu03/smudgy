import implodeShader from "./implode.wgsl";
import { fragments } from "./_families/fragments.ts";

export const implode = fragments(implodeShader, ["#466cc4", "#abdfff", "#ffffff"]);
export default implode;
