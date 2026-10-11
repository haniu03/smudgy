import explodeShader from "./explode.wgsl";
import { fragments } from "./_families/fragments.ts";

export const explode = fragments(explodeShader, ["#db5627", "#ffd897", "#ffffff"]);
export default explode;
