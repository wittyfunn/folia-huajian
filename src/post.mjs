// One full-screen pass over the camera layer: radial chromatic aberration, a
// flash and a touch of barrel distortion. It is switched off whenever all three
// are at rest, so calm passages pay nothing for it.

import * as PIXI from './vendor/pixi.min.mjs';

const vertex = `#version 300 es
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const fragment = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uInputClamp;
uniform float uRgb;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uDistort;

vec4 sampleAt(vec2 uv) {
    return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw));
}

void main(void) {
    // Screen-space uv (0..1 over the filtered area) and back to texture space.
    vec2 toTexture = uOutputFrame.zw * uInputSize.zw;
    vec2 screen = vTextureCoord / toTexture;
    vec2 d = screen - 0.5;
    float r2 = dot(d, d);
    vec2 warped = 0.5 + d * (1.0 - uDistort * r2);
    vec2 base = warped * toTexture;
    vec2 offset = d * uRgb * toTexture;
    vec4 c = sampleAt(base);
    vec4 red = sampleAt(base + offset);
    vec4 blue = sampleAt(base - offset);
    vec4 color = vec4(red.r, c.g, blue.b, max(c.a, max(red.a, blue.a)));
    // Premultiplied: a flash adds light and opacity together.
    color.rgb += uFlashColor * uFlash;
    color.a = max(color.a, uFlash);
    finalColor = color;
}
`;

export const createPost = () => {
  const uniforms = new PIXI.UniformGroup({
    uRgb: { value: 0, type: 'f32' },
    uFlash: { value: 0, type: 'f32' },
    uFlashColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uDistort: { value: 0, type: 'f32' },
  });
  const filter = new PIXI.Filter({
    glProgram: PIXI.GlProgram.from({ vertex, fragment, name: 'huajian-post' }),
    resources: { postUniforms: uniforms },
    // PixiJS filters render at resolution 1 by default: on a high-DPI screen every transition and
    // beat would blur the whole text layer for a moment. Render at the screen's own resolution.
    resolution: 'inherit',
    antialias: 'inherit',
  });
  filter.enabled = false;
  const values = uniforms.uniforms;
  return {
    filter,
    /** `rgb` is a fraction of the screen, `flash` 0..1, `distort` about 0..0.4. */
    set({ rgb = 0, flash = 0, distort = 0, flashColor }) {
      values.uRgb = rgb;
      values.uFlash = Math.min(1, flash);
      values.uDistort = distort;
      if (flashColor) values.uFlashColor.set(flashColor);
      filter.enabled = rgb > 0.0004 || flash > 0.004 || Math.abs(distort) > 0.004;
    },
    destroy() {
      filter.destroy();
    },
  };
};
