use super::*;

const NEUTRAL_SHADER: &str = r"
const TEXT_EFFECT_VERSION: u32 = 1u;
fn effect(position: vec2f) -> vec4f {
    let frame: TextFrame = text;
    let table: GlyphTable = glyphTable;
    let glyph: Glyph = glyphAt(0u);
    let uv = (position - frame.capture_offset) * frame.scale / frame.texture_size;
    let color = textureSampleLevel(textTexture, textSampler, uv, 0.0);
    let noise = textureSampleLevel(noiseTexture, noiseSampler, uv, 0.0).r;
    return color * noise + vec4f(f32(table.info.x) + glyph.advance.x) * 0.0;
}
";
const NEUTRAL_QUADS: &str = r"
const TEXT_FRAGMENTS: u32 = 2u;
fn textVertex(instance: u32, corner: vec2f) -> Fragment {
    let glyph: Glyph = glyphAt(instance / TEXT_FRAGMENTS);
    let source = glyph.advance.xy + corner * glyph.advance.zw;
    return Fragment(source, source, 1.0, 1.0);
}
fn textFragment(color: vec4f, source: vec2f, instance: u32) -> vec4f {
    return color;
}
";

#[test]
fn neutral_types_and_resources_work_in_both_shader_paths() {
    for quads in ["", NEUTRAL_QUADS] {
        let source = format!("{NEUTRAL_SHADER}{quads}");
        let shader = Shader::compile("neutral.wgsl", &source).unwrap();
        assert_eq!(
            shader.fragments_per_glyph,
            if quads.is_empty() { 0 } else { 2 }
        );
        assert!(shader.source.starts_with(&source));
    }
}

#[test]
fn legacy_type_aliases_and_resource_names_preserve_existing_shader_sources() {
    let neutral = format!("{NEUTRAL_SHADER}{NEUTRAL_QUADS}");
    let old_types = neutral
        .replace("TextFrame", "SmudgyTextFrame")
        .replace("GlyphTable", "SmudgyGlyphTable")
        .replace(": Glyph", ": SmudgyGlyph")
        .replace("-> Fragment", "-> SmudgyFragment")
        .replace("return Fragment(", "return SmudgyFragment(");
    // Exercise aliases with neutral resources, then an entirely legacy shader.
    let old_resources = old_types
        .replace("textTexture", "smudgy_glyphs")
        .replace("textSampler", "smudgy_sampler")
        .replace("glyphTable", "smudgy_geometry")
        .replace("noiseTexture", "smudgy_noise")
        .replace("noiseSampler", "smudgy_noise_sampler");
    for source in [old_types, old_resources] {
        // Names in the author's parameter schema must not be rewritten.
        let source = format!(
            "struct Parameters {{ textTexture: f32, smudgy_glyphs: f32 }}\n\
             @group(1) @binding(0) var<uniform> params: Parameters;\n{source}"
        );
        let shader = Shader::compile("existing.wgsl", &source).unwrap();
        assert!(shader.source.starts_with(&source));
        assert_eq!(shader.fragments_per_glyph, 2);
        let values = serde_json::json!({"textTexture": 0.5, "smudgy_glyphs": 0.75});
        let bytes = shader.uniforms(values.as_object().unwrap()).unwrap();
        assert_eq!(&bytes[..4], &0.5_f32.to_le_bytes());
        assert_eq!(&bytes[4..8], &0.75_f32.to_le_bytes());
    }
}

#[test]
fn legacy_resources_do_not_allow_additional_host_bindings() {
    let source = "@group(0) @binding(1) var extra: texture_2d<f32>; \
        fn effect(p: vec2f) -> vec4f { \
        return textureSampleLevel(smudgy_glyphs, smudgy_sampler, p, 0.0); }";
    assert!(Shader::compile("legacy-extra.wgsl", source).is_err());
}

#[test]
fn bundled_shader_catalogue_compiles_with_the_shared_interface() {
    let catalogue =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/text-effects");
    let mut count = 0;
    for entry in std::fs::read_dir(catalogue).unwrap() {
        let path = entry.unwrap().path();
        if path
            .extension()
            .is_some_and(|extension| extension == "wgsl")
        {
            let source = std::fs::read_to_string(&path).unwrap();
            Shader::compile(&path.display().to_string(), &source).unwrap();
            count += 1;
        }
    }
    assert!(count > 0, "the catalogue must contain shaders");
}

#[test]
fn source_and_uniform_buffers_obey_their_byte_limits() {
    let mut source = "fn effect(p: vec2f) -> vec4f { return sampleText(p); }".to_owned();
    source.extend(std::iter::repeat_n(
        ' ',
        MAX_SHADER_SOURCE_BYTES - source.len(),
    ));
    Shader::compile("at-source-cap.wgsl", &source).unwrap();
    source.push(' ');
    assert!(
        Shader::compile("over-source-cap.wgsl", &source)
            .unwrap_err()
            .contains("64 KiB")
    );

    // vec4f occupies sixteen bytes; exercise reflected size and alignment rather
    // than merely counting parameter fields.
    let parameter_source = |fields| {
        let members: String = (0..fields).map(|i| format!("p{i}: vec4f, ")).collect();
        format!(
            "struct P {{ {members} }} @group(1) @binding(0) var<uniform> params: P; fn effect(p: vec2f) -> vec4f {{ return sampleText(p) * params.p0; }}"
        )
    };
    let fields = MAX_UNIFORM_BYTES / 16;
    let shader = Shader::compile("at-uniform-cap.wgsl", &parameter_source(fields)).unwrap();
    assert_eq!(shader.uniform_size, MAX_UNIFORM_BYTES);
    assert!(
        Shader::compile("over-uniform-cap.wgsl", &parameter_source(fields + 1))
            .unwrap_err()
            .contains("uniforms exceed")
    );
}
#[test]
fn scale_and_finite_envelopes_are_bounded_and_finish_cleanly() {
    use std::time::Duration;
    for invalid in [0.0, 0.99, 8.01, f32::INFINITY, f32::NAN] {
        assert!(CaptureScale::new(invalid).is_err());
    }
    assert_eq!(
        CaptureScale::new(8.0).unwrap().get().to_bits(),
        8.0_f32.to_bits()
    );
    for invalid in [0.0, -1.0, 0.24, 4.1, f32::INFINITY, f32::NAN] {
        assert!(EffectScale::new(invalid).is_err());
    }
    assert_eq!(
        EffectScale::new(1.75).unwrap().get().to_bits(),
        1.75_f32.to_bits()
    );
    let effect = ShaderEffect {
        shader: Shader::compile(
            "copy",
            "fn effect(p: vec2f) -> vec4f { return sampleText(p); }",
        )
        .unwrap(),
        uniforms: Arc::from([]),
        pane: false,
        scale: EffectScale::default(),
        capture_scale: Default::default(),
        fade_in_ms: 800,
        fade_out_ms: 800,
        replace: false,
        hold: false,
        animated: false,
    };
    let at = |ms, duration| effect.envelope(Duration::from_millis(ms), duration);
    assert_eq!(at(0, 1000).to_bits(), 0.0_f32.to_bits());
    assert!((at(250, 1000) - 0.5).abs() < 0.001);
    assert_eq!(at(500, 1000).to_bits(), 1.0_f32.to_bits());
    assert!((at(750, 1000) - 0.5).abs() < 0.001);
    assert_eq!(at(1000, 1000).to_bits(), 0.0_f32.to_bits());
    assert_eq!(at(2000, 0).to_bits(), 1.0_f32.to_bits());
    let item = crate::inline_content::InlineDecoration::new(
        0..1,
        crate::inline_content::TextEffect {
            shader: Arc::new(effect),

            duration_ms: 1000,
            outset: 0,
        },
        crate::inline_content::InlineOwner::default(),
    );
    assert!(item.animated(item.started + Duration::from_millis(500)));
    assert!(!item.animated(item.started + Duration::from_millis(1000)));
    assert!(
        item.elapsed(item.started + Duration::from_millis(1000))
            .is_none()
    );
}

#[test]
fn fragment_abi_requires_a_bounded_constant_and_valid_signatures() {
    let functions = "fn effect(p:vec2f)->vec4f{return vec4f(0);} fn textVertex(i:u32,c:vec2f)->Fragment{return Fragment(c,c,1.0,1.0);} fn textFragment(c:vec4f,p:vec2f,i:u32)->vec4f{return c;}";
    for (count, expected) in [("1u", 1), ("16u", 16), ("64u", 64), ("8u*8u", 64)] {
        let shader = Shader::compile(
            "quads",
            &format!("const TEXT_FRAGMENTS:u32={count}; {functions}"),
        )
        .unwrap();
        assert_eq!(shader.fragments_per_glyph, expected);
    }
    for declaration in [
        "",
        "const TEXT_FRAGMENTS:u32=0u;",
        "const TEXT_FRAGMENTS:u32=65u;",
        "const TEXT_FRAGMENTS:f32=4.0;",
    ] {
        assert!(Shader::compile("bad-quads", &format!("{declaration} {functions}")).is_err());
    }
    assert!(
        Shader::compile(
            "bad-signature",
            &format!(
                "const TEXT_FRAGMENTS:u32=1u; {}",
                functions.replace("i:u32,c:vec2f", "i:f32,c:vec2f")
            )
        )
        .is_err()
    );
    assert_eq!(
        Shader::compile(
            "surface",
            "fn effect(p:vec2f)->vec4f{return sampleText(p);}"
        )
        .unwrap()
        .fragments_per_glyph,
        0
    );
}
#[test]
fn integer_uniforms_accept_javascript_numbers_but_reject_fractional_or_out_of_range_values() {
    let shader = Shader::compile("integers.wgsl", "struct P { signed_value: i32, unsigned_value: u32 } @group(1) @binding(0) var<uniform> p: P; fn effect(v: vec2f) -> vec4f { return vec4f(f32(p.signed_value + i32(p.unsigned_value))); }").unwrap();
    let values = serde_json::json!({"signed_value": -2.0, "unsigned_value": 4294967295.0});
    let packed = shader.uniforms(values.as_object().unwrap()).unwrap();
    assert_eq!(&packed[..4], &(-2i32).to_le_bytes());
    assert_eq!(&packed[4..8], &u32::MAX.to_le_bytes());
    for bad in [-1.0, 0.5, 4294967296.0] {
        assert!(
            shader
                .uniforms(
                    serde_json::json!({"signed_value": 0, "unsigned_value": bad})
                        .as_object()
                        .unwrap()
                )
                .is_err()
        );
    }
}
#[test]
fn shaders_can_sample_filtered_host_noise_without_custom_resources() {
    let shader = Shader::compile("volume.wgsl", "fn effect(p: vec2f) -> vec4f { let n = noise3D(vec3f(p, text.time), 1.5); return sampleTextLod(p, 2.0) * (n * 0.5 + 0.5); }").unwrap();
    assert_eq!(shader.fragments_per_glyph, 0);
    assert!(shader.fields.is_empty());
}
#[test]
fn invalid_source_and_custom_resources_are_rejected() {
    assert!(
        Shader::compile("bad.wgsl", "this is not wgsl")
            .unwrap_err()
            .contains("bad.wgsl")
    );
    for source in [
        "override value: f32; fn effect(p: vec2f) -> vec4f { return vec4f(value); }",
        "@group(0) @binding(1) var extra: texture_2d<f32>; fn effect(p: vec2f) -> vec4f { return vec4f(0); }",
        "@group(0) @binding(4) var extra: texture_2d<f32>; fn effect(p: vec2f) -> vec4f { return vec4f(0); }",
        "@group(0) @binding(5) var extra: sampler; fn effect(p: vec2f) -> vec4f { return vec4f(0); }",
        "struct P { a: f32 } @group(1) @binding(0) var<uniform> a: P; @group(1) @binding(0) var<uniform> b: P; fn effect(p: vec2f) -> vec4f { return vec4f(0); }",
    ] {
        assert!(Shader::compile("invalid.wgsl", source).is_err());
    }
    let invalid = "@group(2) @binding(0) var extra: texture_2d<f32>; fn effect(p: vec2f) -> vec4f { return vec4f(0.0); }";
    assert!(
        Shader::compile("extra.wgsl", invalid)
            .unwrap_err()
            .contains("resources")
    );
}
#[test]
fn shader_labels_have_a_separate_byte_bound() {
    let source = "fn effect(p: vec2f) -> vec4f { return sampleText(p); }";
    assert!(Shader::compile(&"x".repeat(MAX_SHADER_LABEL_BYTES), source).is_ok());
    assert!(
        Shader::compile(&"x".repeat(MAX_SHADER_LABEL_BYTES + 1), source)
            .unwrap_err()
            .contains("label exceeds")
    );
}
