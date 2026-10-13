import { buffer, createTrigger, echo, line, style } from "smudgy:core";
import { Button, Span, TextEffect } from "smudgy:widgets";
import plain from "./plain.wgsl";
import custom from "./copy.wgsl";

function check(value: unknown, message: string) {
    if (!value) throw Error(message);
}
function rejects(action: () => unknown, message?: string) {
    try { action(); }
    catch (error) {
        if (message) check(String(error).includes(message), String(error));
        return;
    }
    throw Error("invalid shader highlight accepted");
}
createTrigger(/^Dir /, () => {
    check(line.highlight("caféXYZ", plain), "direct match missing");
    check(!line.highlight("absent", plain), "absent match");
    check(!line.highlight("", plain), "empty match");
    line.highlightAt(8, 8, plain);
});
let stored: typeof line;
createTrigger(/^Old /, () => { stored = buffer.line(line.number); });
createTrigger(/^edit-stored$/, () => {
    check(stored.highlight("caféXYZ", custom, {
        uniforms: { strength: 0.75 }, duration: 2000, scale: 2,
        captureScale: 2, fadeIn: 100, fadeOut: 200, outset: 48,
        overflow: "pane", composite: "replace", finish: "hold", animated: false,
    }), "stored match missing");
});
createTrigger(/^Idx /, () => line.highlightAt(8, 12, plain));
createTrigger(/^Seq /, () => {
    line.replace("foo", <Span fontSize={28}>{style.green`caféXYZ`}</Span>);
    check(line.highlight("caféXYZ", plain), "pending replacement not matched");
});
createTrigger(/^Bad /, () => {
    for (const options of [
        {}, { uniforms: { strength: NaN } }, { uniforms: { strength: [1, 2] } },
        { uniforms: { strength: 1, extra: 1 } },
    ]) rejects(() => line.highlight("caféXYZ", custom, options));
    for (const options of [
        { scale: 0 }, { captureScale: 9 }, { duration: 1.5 }, { duration: -1 },
        { overflow: "invalid" }, { composite: "invalid" }, { finish: "invalid" },
        { fadeIn: 3600001 }, { fadeIn: -1 }, { fadeOut: 0.5 },
        { duration: NaN }, { duration: Infinity }, { duration: 4294967296 },
        { outset: -1 }, { outset: 0.5 }, { outset: 65536 },
    ]) {
        rejects(() => line.highlight("caféXYZ", plain, options as any));
        rejects(() => TextEffect({ shader: plain, ...options } as any, "same validation"));
    }
    rejects(() => line.highlight("caféXYZ", {} as any, { duration: 1 }));
    echo("SHADER_ERRORS_CHECKED");
});
createTrigger(/^Obj /, () => {
    // Reject the entire call even when the first match contains ordinary text.
    line.replaceAt(<Button>caféXYZ</Button>, 15, 23);
    rejects(() => line.highlight("caféXYZ", plain), "embedded widgets");
    echo("SHADER_WIDGET_CHECKED");
});
createTrigger(/^Heavy /, () => {
    check(line.highlight("x".repeat(5000), plain), "many style runs rejected");
});
createTrigger(/^verify-shaders$/, () => {
    check(!buffer.line(999999).highlight("text", plain), "missing row matched");
    echo("SHADER_DONE");
});
echo("SHADER_READY");
