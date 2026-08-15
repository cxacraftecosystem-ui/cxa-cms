"use client";

/**
 * VoicePoweredOrb — the supplied WebGL orb, adopted into the house.
 *
 * ORIGIN. This is the owner-supplied "voice-powered orb" component (an `ogl` full-screen-triangle
 * shader: a ring of simplex-noise plasma whose rotation and shimmer answer the microphone),
 * integrated per the shadcn-style brief: the file lives in `components/ui/`, the classes go
 * through `cn`, and the shader is untouched. Its default palette is ALREADY the site's violet
 * (baseColor1 ≈ oklch-purple), which is why `hue` defaults to 0 here.
 *
 * WHAT WAS ADAPTED, AND WHY (repo contract, not taste):
 *   • The console chatter is gone — this repo logs errors, not narration.
 *   • `webkitAudioContext` is reached through a typed interface instead of `any`.
 *   • The microphone NEVER starts on its own: `enableVoiceControl` defaults FALSE and the second
 *     "handle microphone state" effect from the source (which double-initialised the stream) is
 *     folded into the main one. A public page requesting the mic on mount is a trust cost nothing
 *     visual can repay — the caller renders an explicit control (see AiOrb).
 *   • `onVoiceDetected` fires ON CHANGE, not per frame — the source called it every rAF tick,
 *     which is a parent re-render storm for any caller that stores the flag.
 *
 * ⚠ THE CALLER OWNS THE LIFECYCLE ECONOMY. This component runs a rAF loop from mount to unmount,
 * exactly like the source. Anything mounting it on a long page must gate it on visibility and on
 * reduced motion (AiOrb does both) — the same rule ParticleField enforces internally.
 */

import { Mesh, Program, Renderer, Triangle, Vec3, type OGLRenderingContext } from "ogl";
import { useEffect, useRef, type FC } from "react";

import { cn } from "@/lib/utils";

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export interface VoicePoweredOrbProps {
  className?: string;
  /** Degrees of hue rotation over the shader's own violet/cyan palette. 0 is the site's violet. */
  hue?: number;
  /** ⚠ Off by default — see the header. The microphone is an explicit, user-granted mode. */
  enableVoiceControl?: boolean;
  voiceSensitivity?: number;
  maxRotationSpeed?: number;
  maxHoverIntensity?: number;
  /** Called when speech starts/stops being detected — on the EDGE, not per frame. */
  onVoiceDetected?: (detected: boolean) => void;
}

const vert = /* glsl */ `
  precision highp float;
  attribute vec2 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const frag = /* glsl */ `
  precision highp float;

  uniform float iTime;
  uniform vec3 iResolution;
  uniform float hue;
  uniform float hover;
  uniform float rot;
  uniform float hoverIntensity;
  varying vec2 vUv;

  vec3 rgb2yiq(vec3 c) {
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    float i = dot(c, vec3(0.596, -0.274, -0.322));
    float q = dot(c, vec3(0.211, -0.523, 0.312));
    return vec3(y, i, q);
  }

  vec3 yiq2rgb(vec3 c) {
    float r = c.x + 0.956 * c.y + 0.621 * c.z;
    float g = c.x - 0.272 * c.y - 0.647 * c.z;
    float b = c.x - 1.106 * c.y + 1.703 * c.z;
    return vec3(r, g, b);
  }

  vec3 adjustHue(vec3 color, float hueDeg) {
    float hueRad = hueDeg * 3.14159265 / 180.0;
    vec3 yiq = rgb2yiq(color);
    float cosA = cos(hueRad);
    float sinA = sin(hueRad);
    float i = yiq.y * cosA - yiq.z * sinA;
    float q = yiq.y * sinA + yiq.z * cosA;
    yiq.y = i;
    yiq.z = q;
    return yiq2rgb(yiq);
  }

  vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
    p3 += dot(p3, p3.yxz + 19.19);
    return -1.0 + 2.0 * fract(vec3(
      p3.x + p3.y,
      p3.x + p3.z,
      p3.y + p3.z
    ) * p3.zyx);
  }

  float snoise3(vec3 p) {
    const float K1 = 0.333333333;
    const float K2 = 0.166666667;
    vec3 i = floor(p + (p.x + p.y + p.z) * K1);
    vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
    vec3 e = step(vec3(0.0), d0 - d0.yzx);
    vec3 i1 = e * (1.0 - e.zxy);
    vec3 i2 = 1.0 - e.zxy * (1.0 - e);
    vec3 d1 = d0 - (i1 - K2);
    vec3 d2 = d0 - (i2 - K1);
    vec3 d3 = d0 - 0.5;
    vec4 h = max(0.6 - vec4(
      dot(d0, d0),
      dot(d1, d1),
      dot(d2, d2),
      dot(d3, d3)
    ), 0.0);
    vec4 n = h * h * h * h * vec4(
      dot(d0, hash33(i)),
      dot(d1, hash33(i + i1)),
      dot(d2, hash33(i + i2)),
      dot(d3, hash33(i + 1.0))
    );
    return dot(vec4(31.316), n);
  }

  vec4 extractAlpha(vec3 colorIn) {
    float a = max(max(colorIn.r, colorIn.g), colorIn.b);
    return vec4(colorIn.rgb / (a + 1e-5), a);
  }

  const vec3 baseColor1 = vec3(0.611765, 0.262745, 0.996078);
  const vec3 baseColor2 = vec3(0.298039, 0.760784, 0.913725);
  const vec3 baseColor3 = vec3(0.062745, 0.078431, 0.600000);
  const float innerRadius = 0.6;
  const float noiseScale = 0.65;

  float light1(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * attenuation);
  }

  float light2(float intensity, float attenuation, float dist) {
    return intensity / (1.0 + dist * dist * attenuation);
  }

  vec4 draw(vec2 uv) {
    vec3 color1 = adjustHue(baseColor1, hue);
    vec3 color2 = adjustHue(baseColor2, hue);
    vec3 color3 = adjustHue(baseColor3, hue);

    float ang = atan(uv.y, uv.x);
    float len = length(uv);
    float invLen = len > 0.0 ? 1.0 / len : 0.0;

    float n0 = snoise3(vec3(uv * noiseScale, iTime * 0.5)) * 0.5 + 0.5;
    float r0 = mix(mix(innerRadius, 1.0, 0.4), mix(innerRadius, 1.0, 0.6), n0);
    float d0 = distance(uv, (r0 * invLen) * uv);
    float v0 = light1(1.0, 10.0, d0);
    v0 *= smoothstep(r0 * 1.05, r0, len);
    float cl = cos(ang + iTime * 2.0) * 0.5 + 0.5;

    float a = iTime * -1.0;
    vec2 pos = vec2(cos(a), sin(a)) * r0;
    float d = distance(uv, pos);
    float v1 = light2(1.5, 5.0, d);
    v1 *= light1(1.0, 50.0, d0);

    float v2 = smoothstep(1.0, mix(innerRadius, 1.0, n0 * 0.5), len);
    float v3 = smoothstep(innerRadius, mix(innerRadius, 1.0, 0.5), len);

    vec3 col = mix(color1, color2, cl);
    col = mix(color3, col, v0);
    col = (col + v1) * v2 * v3;
    col = clamp(col, 0.0, 1.0);

    return extractAlpha(col);
  }

  vec4 mainImage(vec2 fragCoord) {
    vec2 center = iResolution.xy * 0.5;
    float size = min(iResolution.x, iResolution.y);
    vec2 uv = (fragCoord - center) / size * 2.0;

    float angle = rot;
    float s = sin(angle);
    float c = cos(angle);
    uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

    uv.x += hover * hoverIntensity * 0.1 * sin(uv.y * 10.0 + iTime);
    uv.y += hover * hoverIntensity * 0.1 * sin(uv.x * 10.0 + iTime);

    return draw(uv);
  }

  void main() {
    vec2 fragCoord = vUv * iResolution.xy;
    vec4 col = mainImage(fragCoord);
    gl_FragColor = vec4(col.rgb * col.a, col.a);
  }
`;

export const VoicePoweredOrb: FC<VoicePoweredOrbProps> = ({
  className,
  hue = 0,
  enableVoiceControl = false,
  voiceSensitivity = 1.5,
  maxRotationSpeed = 1.2,
  maxHoverIntensity = 0.8,
  onVoiceDetected
}) => {
  const ctnDom = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const microphoneRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  /** The last edge reported through `onVoiceDetected`, so the callback fires on CHANGE only. */
  const lastDetectedRef = useRef(false);

  useEffect(() => {
    const container = ctnDom.current;
    if (!container) return;

    const analyzeAudio = (): number => {
      const analyser = analyserRef.current;
      const data = dataArrayRef.current;
      if (!analyser || !data) return 0;

      analyser.getByteFrequencyData(data);

      // RMS rather than a peak — a single loud bin (a click, a hum) should not read as speech.
      let sum = 0;
      for (let index = 0; index < data.length; index += 1) {
        const value = (data[index] ?? 0) / 255;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);
      return Math.min(rms * voiceSensitivity * 3.0, 1);
    };

    const stopMicrophone = () => {
      try {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        microphoneRef.current?.disconnect();
        microphoneRef.current = null;
        analyserRef.current?.disconnect();
        analyserRef.current = null;
        if (audioContextRef.current && audioContextRef.current.state !== "closed") {
          void audioContextRef.current.close();
        }
        audioContextRef.current = null;
        dataArrayRef.current = null;
      } catch {
        // A teardown that throws must not take the page with it; every ref above is now null
        // or stopped, which is the state the next init expects.
      }
    };

    const initMicrophone = async (): Promise<boolean> => {
      try {
        stopMicrophone();

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // All three OFF is deliberate: processing tuned for calls flattens exactly the
            // dynamics the analyser is listening for.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 44100
          }
        });

        mediaStreamRef.current = stream;

        const AudioContextCtor =
          window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
        if (!AudioContextCtor) return false;
        audioContextRef.current = new AudioContextCtor();

        if (audioContextRef.current.state === "suspended") {
          await audioContextRef.current.resume();
        }

        analyserRef.current = audioContextRef.current.createAnalyser();
        microphoneRef.current = audioContextRef.current.createMediaStreamSource(stream);

        analyserRef.current.fftSize = 512;
        analyserRef.current.smoothingTimeConstant = 0.3;
        analyserRef.current.minDecibels = -90;
        analyserRef.current.maxDecibels = -10;

        microphoneRef.current.connect(analyserRef.current);
        dataArrayRef.current = new Uint8Array(new ArrayBuffer(analyserRef.current.frequencyBinCount));
        return true;
      } catch {
        // Denied or absent. The orb simply stays in its ambient state; the caller's toggle is
        // where "it did not work" is communicated, not a console.
        return false;
      }
    };

    let rendererInstance: Renderer | null = null;
    let glContext: OGLRenderingContext | null = null;
    let rafId = 0;
    let program: Program | null = null;

    try {
      rendererInstance = new Renderer({
        alpha: true,
        premultipliedAlpha: false,
        antialias: true,
        dpr: window.devicePixelRatio || 1
      });
      glContext = rendererInstance.gl;
      glContext.clearColor(0, 0, 0, 0);
      glContext.enable(glContext.BLEND);
      glContext.blendFunc(glContext.SRC_ALPHA, glContext.ONE_MINUS_SRC_ALPHA);

      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      container.appendChild(glContext.canvas);

      const geometry = new Triangle(glContext);
      program = new Program(glContext, {
        vertex: vert,
        fragment: frag,
        uniforms: {
          iTime: { value: 0 },
          iResolution: {
            value: new Vec3(
              glContext.canvas.width,
              glContext.canvas.height,
              glContext.canvas.width / glContext.canvas.height
            )
          },
          hue: { value: hue },
          hover: { value: 0 },
          rot: { value: 0 },
          hoverIntensity: { value: 0 }
        }
      });

      const mesh = new Mesh(glContext, { geometry, program });

      const resize = () => {
        if (!container || !rendererInstance || !glContext) return;
        const dpr = window.devicePixelRatio || 1;
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;

        rendererInstance.setSize(width * dpr, height * dpr);
        glContext.canvas.style.width = `${width}px`;
        glContext.canvas.style.height = `${height}px`;

        program?.uniforms.iResolution?.value.set(
          glContext.canvas.width,
          glContext.canvas.height,
          glContext.canvas.width / glContext.canvas.height
        );
      };
      window.addEventListener("resize", resize);
      resize();

      let lastTime = 0;
      let currentRot = 0;
      let voiceLevel = 0;
      const baseRotationSpeed = 0.3;
      let microphoneReady = false;

      if (enableVoiceControl) {
        void initMicrophone().then((success) => {
          microphoneReady = success;
        });
      }

      const report = (detected: boolean) => {
        if (detected === lastDetectedRef.current) return;
        lastDetectedRef.current = detected;
        onVoiceDetected?.(detected);
      };

      const update = (t: number) => {
        rafId = requestAnimationFrame(update);
        if (!program) return;

        const dt = (t - lastTime) * 0.001;
        lastTime = t;
        if (program.uniforms.iTime) program.uniforms.iTime.value = t * 0.001;
        if (program.uniforms.hue) program.uniforms.hue.value = hue;

        if (enableVoiceControl && microphoneReady) {
          voiceLevel = analyzeAudio();
          report(voiceLevel > 0.1);

          const voiceRotationSpeed = baseRotationSpeed + voiceLevel * maxRotationSpeed * 2.0;
          if (voiceLevel > 0.05) {
            currentRot += dt * voiceRotationSpeed;
          }
          if (program.uniforms.hover) {
            program.uniforms.hover.value = Math.min(voiceLevel * 2.0, 1.0);
          }
          if (program.uniforms.hoverIntensity) {
            program.uniforms.hoverIntensity.value = Math.min(
              voiceLevel * maxHoverIntensity * 0.8,
              maxHoverIntensity
            );
          }
        } else {
          // The ambient state: a slow, even turn. The source held the orb static without the
          // microphone, which read as a stopped video; a presence should breathe on its own.
          currentRot += dt * baseRotationSpeed * 0.5;
          if (program.uniforms.hover) program.uniforms.hover.value = 0;
          if (program.uniforms.hoverIntensity) program.uniforms.hoverIntensity.value = 0;
          report(false);
        }

        if (program.uniforms.rot) program.uniforms.rot.value = currentRot;

        if (rendererInstance && glContext) {
          glContext.clear(glContext.COLOR_BUFFER_BIT | glContext.DEPTH_BUFFER_BIT);
          rendererInstance.render({ scene: mesh });
        }
      };

      rafId = requestAnimationFrame(update);

      return () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener("resize", resize);
        if (container && glContext?.canvas && container.contains(glContext.canvas)) {
          try {
            container.removeChild(glContext.canvas);
          } catch {
            // Already gone — React strict-mode double effects can race the removal.
          }
        }
        stopMicrophone();
        glContext?.getExtension("WEBGL_lose_context")?.loseContext();
      };
    } catch (error) {
      console.error("VoicePoweredOrb could not initialise WebGL:", error);
      stopMicrophone();
      return undefined;
    }
  }, [hue, enableVoiceControl, voiceSensitivity, maxRotationSpeed, maxHoverIntensity, onVoiceDetected]);

  return <div ref={ctnDom} className={cn("relative h-full w-full", className)} />;
};
