// Animated background shader for the marketing hero.
// Uses the vanilla @paper-design/shaders package via esm.sh — no bundler needed.

import {
  ShaderMount,
  meshGradientFragmentShader,
  getShaderColorFromString,
  defaultObjectSizing,
  ShaderFitOptions,
} from "https://esm.sh/@paper-design/shaders@0.0.76";

const host = document.querySelector(".hero-shader");
if (host && typeof WebGL2RenderingContext !== "undefined") {
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  const lightColors = ["#f2c9ff", "#7fc8ff", "#ffb27a", "#a6f3d5", "#c7a3ff"];
  const darkColors = ["#1a2b3c", "#2d6a7f", "#8ae6c7", "#5b3a8a", "#c7a3ff"];
  const palette = isDark ? darkColors : lightColors;

  const uniforms = {
    u_colors: palette.map(getShaderColorFromString),
    u_colorsCount: palette.length,
    u_distortion: 0.85,
    u_swirl: 0.55,
    u_grainMixer: 0,
    u_grainOverlay: 0.1,

    // Sizing uniforms (from defaultObjectSizing, cover the whole host)
    u_fit: ShaderFitOptions.cover ?? 2,
    u_rotation: defaultObjectSizing.rotation,
    u_scale: defaultObjectSizing.scale,
    u_offsetX: defaultObjectSizing.offsetX,
    u_offsetY: defaultObjectSizing.offsetY,
    u_originX: defaultObjectSizing.originX,
    u_originY: defaultObjectSizing.originY,
    u_worldWidth: defaultObjectSizing.worldWidth,
    u_worldHeight: defaultObjectSizing.worldHeight,
  };

  const speed = prefersReduced ? 0 : 0.25;
  // eslint-disable-next-line no-new
  new ShaderMount(host, meshGradientFragmentShader, uniforms, undefined, speed);
}
