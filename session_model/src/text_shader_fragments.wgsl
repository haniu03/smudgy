// Instanced text-fragment ABI. Instance zero paints the ordinary effect surface;
// each remaining instance is an author-controlled, perspective-correct quad.
struct te_host_FragmentOutput {
    @builtin(position) position: vec4f,
    @location(0) source: vec2f,
    @location(1) opacity: f32,
    @location(2) @interpolate(flat) instance: u32,
}
@vertex fn te_host_vs(@builtin(vertex_index) vertex: u32,
    @builtin(instance_index) instance: u32) -> te_host_FragmentOutput {
    let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1),
        vec2f(0,1), vec2f(1,0), vec2f(1,1));
    let corner = corners[vertex];
    var fragment = Fragment(text.paint_offset + corner * text.surface,
        vec2f(0), 1.0, 1.0);
    if instance > 0u { fragment = textVertex(instance - 1u, corner); }
    let position = (fragment.position - text.paint_offset) / text.surface;
    let w = max(fragment.perspective, 0.05);
    return te_host_FragmentOutput(vec4f((position * vec2f(2,-2) + vec2f(-1,1)) * w,
        0.0, w), fragment.source, fragment.opacity, instance);
}
@fragment fn te_host_fs(v: te_host_FragmentOutput) -> @location(0) vec4f {
    let p = (v.position.xy - text.origin) / text.resolution * text.surface + text.paint_offset;
    var color = vec4f(0);
    if v.instance == 0u {
        color = effect(p);
        var original = vec4f(0);
        if text.replaces_text != 0u { original = sampleText(p); }
        color = mix(original, color, text.envelope);
    } else {
        if v.opacity <= 0.0 { return vec4f(0); }
        color = textFragment(sampleText(v.source), v.source, v.instance - 1u)
            * clamp(v.opacity, 0.0, 1.0) * text.envelope;
    }
    if text.linearize != 0u && color.a > 0.0 {
        let rgb = color.rgb / color.a;
        color = vec4f(select(rgb / 12.92, pow((rgb + 0.055) / 1.055, vec3f(2.4)),
            rgb > vec3f(0.04045)) * color.a, color.a);
    }
    return color;
}
