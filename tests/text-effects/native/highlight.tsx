import { buffer, createTrigger, echo, line, link, style } from "smudgy:core";
import { Span, Button } from "smudgy:widgets";
import Effect from "@text-effects/possession";

function check(value: unknown, message: string) {
    if (!value) throw Error(message);
}
function decorate(target: typeof line) {
    // Earlier queued edits must survive the rich snapshot, including callable
    // style builders and link tags accepted by the original overloads.
    target.highlightAt(4, 9, style.red.bold);
    target.highlight("XYZ", style.blue);
    target.highlightAt(15, 20, link(() => echo("HIGHLIGHT_LINK_CLICKED")));
    let count = 0;
    check(target.highlight("caféXYZ", span => {
        count++;
        return <Effect intensity={1} duration={2000} scale={2}
            colors={['#00ff00', '#cceecc', '#ddeedd']}>{span}</Effect>;
    }), "expected matches");
    check(count === 2, "one callback per occurrence, not per style run");
    // Replace an existing effect; mid-codepoint byte offsets snap down.
    target.highlightAt(8, 12, span => <Effect duration={1200}>{span}</Effect>);
    check(!target.highlight("absent", () => { throw Error("unmatched callback ran"); }), "absent match");
    check(!target.highlight("", () => { throw Error("empty callback ran"); }), "empty match");
    target.highlightAt(8, 8, () => { throw Error("empty range callback ran"); });
}
createTrigger(/^Foo /, () => decorate(line));
let stored: typeof line;
createTrigger(/^Old /, () => { stored = buffer.line(line.number); });
createTrigger(/^edit-stored$/, () => decorate(stored));

createTrigger(/^Seq /, () => {
    line.replace("foo", <Span fontSize={28}>{style.green`caféXYZ`}</Span>);
    check(line.highlight("caféXYZ", span => <Effect>{span}</Effect>), "pending replacement not matched");
});
createTrigger(/^Mix /, () => {
    let occurrence = 0;
    line.highlight("caféXYZ", span => ++occurrence === 1
        ? <Effect>{span}</Effect>
        : <Span fontSize={32}>{style.red.bold`caféXYZ`}</Span>);
});
createTrigger(/^Obj /, () => {
    line.replaceAt(<Button>caféXYZ</Button>, 4, 12);
    let failed = false;
    try { line.highlight("caféXYZ", () => { throw Error("widget fragment reached callback"); }); }
    catch (error) {
        check(String(error).includes("embedded widgets"), "expected native widget rejection");
        failed = true;
    }
    check(failed, "embedded widget accepted");
    echo("HIGHLIGHT_WIDGET_CHECKED");
});
createTrigger(/^Mut /, () => {
    let failed = false;
    try {
        line.highlight("caféXYZ", span => {
            line.highlightAt(4, 9, style.red);
            return <Effect>{span}</Effect>;
        });
    } catch { failed = true; }
    check(failed, "callback edited its target without detection");
    echo("HIGHLIGHT_MUTATION_CHECKED");
});

createTrigger(/^Bad /, () => {
    const cases: Array<(span: any, index: number) => any> = [
        (span, index) => { if (index === 2) throw Error("second callback failed"); return <Effect>{span}</Effect>; },
        (span, index) => index === 2 ? <Span>changed</Span> : <Effect>{span}</Effect>,
        span => Promise.resolve(<Effect>{span}</Effect>),
        () => <Button>caféXYZ</Button>,
        () => undefined,
    ];
    for (const transform of cases) {
        let count = 0;
        let failed = false;
        try { line.highlight("caféXYZ", span => transform(span, ++count)); }
        catch { failed = true; }
        check(failed, "invalid highlight accepted");
    }
    echo("HIGHLIGHT_ERRORS_CHECKED");
});
createTrigger(/^verify-highlights$/, () => {
    check(stored.text === "Old caféXYZ + caféXYZ", "stored text changed");
    check(!buffer.line(999999).highlight("text", () => { throw Error("missing row callback"); }), "missing row matched");
    echo("HIGHLIGHT_DONE");
});
echo("HIGHLIGHT_READY");
