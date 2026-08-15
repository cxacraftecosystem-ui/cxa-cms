"use client";

/**
 * Artifact3D — the glTF artefact viewer on a craft page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NEVER AN EMPTY CANVAS, AND FIVE WAYS IT CAN FAIL ARE ALL SPELLED OUT ON SCREEN.
 *
 *   1. no `modelObjectKey` — the caller does not render this component at all;
 *   2. no public storage base, so the key cannot be turned into a URL — a labelled panel, because
 *      that is a configuration fault an editor can report rather than an artefact that "does not work";
 *   3. WebGL unavailable — an older machine, a locked-down browser, a blocked GPU;
 *   4. the viewer's own code failing to download;
 *   5. the model failing to parse or fetch.
 *
 * Every one of them renders a sentence in plain words. A 3D viewer that silently shows a grey square
 * is indistinguishable from an archive with nothing in it.
 *
 * THE LIBRARIES LOAD WHEN THE READER ASKS FOR THEM. react-three-fiber, drei and three together are
 * over a megabyte, and a glTF scan of a woodblock is frequently several more — on a metered connection
 * that is a real cost, and it is not one to spend on a reader who came to read the text. So the panel
 * opens as a poster with a button that says what pressing it will do. This also IS the `ssr: false`
 * discipline: nothing touches WebGL, `window` or the loaders until after a click, so there is no server
 * render to disagree with and no `next/dynamic` wrapper needed (which a Server Component could not
 * declare anyway).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `frameloop="demand"` AND NO DAMPING, TOGETHER. A viewer left idling at sixty frames a second heats a
 * laptop for a static object; on demand, frames are drawn when something changes — drei's OrbitControls
 * invalidates on every change, and the model invalidates once when it arrives. Damping is inertia, and
 * inertia both needs a continuous loop and is motion nobody asked for. There is no auto-rotate for the
 * same reason: it would be unrequested movement, and a reduced-motion branch for a thing that should
 * not exist is worse than not building it.
 *
 * ⚠ DRACO DECODING FETCHES ITS DECODER FROM A GOOGLE-HOSTED PATH (drei's default). Most heritage scans
 * are Draco- or meshopt-compressed, so turning it off would fail to load the very files this viewer
 * exists for — meshopt's decoder is bundled, Draco's is not. A deployment that must not touch
 * third-party hosts should self-host the decoder and call `useGLTF.setDecoderPath()` once at startup.
 *
 * EVERYTHING IS DISPOSED ON UNMOUNT. A WebGL context, a geometry, a texture and a material are all
 * GPU allocations that outlive a client-side navigation, and browsers cap contexts at around sixteen
 * (the same trap MapSection documents). The suspense cache is cleared as well, or the next visit to the
 * same craft would hand back a scene whose buffers have just been freed.
 */

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { Box, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { publicObjectUrl } from "@/lib/media/url";
import { cn } from "@/lib/utils";

/**
 * Type-only module references. They are erased at runtime — nothing here is in the page's bundle —
 * and importing the declarations is also what puts three.js's elements (`<group>`, `<primitive>`,
 * `<ambientLight>`) into the JSX namespace.
 */
type FiberModule = typeof import("@react-three/fiber");
type DreiModule = typeof import("@react-three/drei");
type ThreeModule = typeof import("three");

interface ViewerModules {
  fiber: FiberModule;
  drei: DreiModule;
  three: ThreeModule;
}

/** The largest dimension the model is scaled to, in scene units. The camera is placed against this. */
const MODEL_SPAN = 1.6;

export interface Artifact3DProps {
  /** `Craft.modelObjectKey`. The caller renders this component only when the column is set. */
  objectKey: string;
  /** The artefact's name, for the viewer's accessible label and the button's wording. */
  title: string;
  className?: string;
}

type Stage = "idle" | "unsupported" | "loading" | "ready" | "libraryFailed" | "modelFailed";

export function Artifact3D({ objectKey, title, className }: Artifact3DProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [modules, setModules] = useState<ViewerModules | null>(null);
  /** Bumped by "Try again", so a second attempt remounts the boundary and re-runs the loader. */
  const [attempt, setAttempt] = useState(0);

  const modulesRef = useRef<ViewerModules | null>(null);
  const sceneRef = useRef<object | null>(null);

  // Null when no CDN or public storage base is configured — never a plausible-looking relative path
  // that would resolve to this page and be parsed as a model (lib/media/url.ts).
  const src = publicObjectUrl(objectKey);

  const load = useCallback(async () => {
    if (!webglAvailable()) {
      setStage("unsupported");
      return;
    }

    setStage("loading");

    try {
      // In parallel: three is a dependency of the other two, so all three resolve out of one chunk.
      const [fiber, drei, three] = await Promise.all([
        import("@react-three/fiber"),
        import("@react-three/drei"),
        import("three")
      ]);
      const loaded: ViewerModules = { fiber, drei, three };
      modulesRef.current = loaded;
      setModules(loaded);
    } catch {
      setStage("libraryFailed");
    }
  }, []);

  const onModelReady = useCallback(() => setStage("ready"), []);
  const onModelFailed = useCallback(() => setStage("modelFailed"), []);

  const retry = () => {
    const loaded = modulesRef.current;
    if (loaded && src) loaded.drei.useGLTF.clear(src);
    sceneRef.current = null;
    setStage("loading");
    setAttempt((count) => count + 1);
  };

  // Free the GPU on the way out. Written against refs rather than state so the cleanup sees the last
  // values without the effect re-running — and therefore re-disposing — on every render.
  useEffect(
    () => () => {
      const loaded = modulesRef.current;
      const scene = sceneRef.current;
      if (loaded && scene) disposeTree(loaded.three, scene);
      if (loaded && src) loaded.drei.useGLTF.clear(src);
      modulesRef.current = null;
      sceneRef.current = null;
    },
    [src]
  );

  if (!src) {
    return (
      <ViewerFrame className={className}>
        <Notice
          icon={TriangleAlert}
          title="The 3D artefact cannot be shown"
          body="A model is recorded for this craft, but no public storage address is configured on this deployment, so there is nothing to load. The photographs above are unaffected."
        />
      </ViewerFrame>
    );
  }

  if (stage === "idle") {
    return (
      <ViewerFrame className={className}>
        <div className="flex flex-col items-center gap-4 p-8 text-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-purple-100 text-purple-700">
            <Box aria-hidden="true" className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-base font-semibold text-ink-900">
              A 3D model of this artefact is available
            </p>
            <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">
              It is downloaded only when you ask for it. The model and the viewer together are
              several megabytes, which is worth knowing on a metered connection. Rotating it needs a
              pointer or a touch screen; the photographs above show the artefact itself.
            </p>
          </div>
          <Button onClick={() => void load()} icon={Box}>
            Load the 3D model
          </Button>
        </div>
      </ViewerFrame>
    );
  }

  if (stage === "unsupported") {
    return (
      <ViewerFrame className={className}>
        <Notice
          icon={TriangleAlert}
          title="This browser cannot show the 3D model"
          body="The viewer needs WebGL, which is either unavailable or switched off here. Everything else on this page works normally."
        />
      </ViewerFrame>
    );
  }

  if (stage === "libraryFailed") {
    return (
      <ViewerFrame className={className}>
        <Notice
          icon={TriangleAlert}
          title="The 3D viewer could not be loaded"
          body="Its code did not finish downloading. This is usually a dropped connection rather than a problem with the model."
          action={
            <Button variant="secondary" icon={RotateCcw} onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      </ViewerFrame>
    );
  }

  if (stage === "modelFailed") {
    return (
      <ViewerFrame className={className}>
        <Notice
          icon={TriangleAlert}
          title="The model could not be opened"
          body="The file did not download, or it is not a glTF model this viewer understands. The photographs above are unaffected."
          action={
            <Button variant="secondary" icon={RotateCcw} onClick={retry}>
              Try again
            </Button>
          }
        />
      </ViewerFrame>
    );
  }

  return (
    <figure className={cn("min-w-0", className)}>
      <div
        // `group` rather than `img`: the canvas is operated, not merely looked at, and `img` would
        // remove its contents from the accessibility tree. What the model shows is described by the
        // gallery captions beside it.
        role="group"
        aria-label={`Three-dimensional model of ${title}`}
        className="relative h-[24rem] overflow-hidden rounded-lg border border-line-200 bg-surface-100 sm:h-[30rem]"
      >
        {modules ? (
          // The boundary is OUTSIDE the canvas on purpose: a loader failure inside the three.js tree
          // propagates out to it, and the whole canvas is then replaced by the explanation rather than
          // left standing empty. `key` restarts it for a retry.
          <ModelBoundary key={attempt} onFailure={onModelFailed}>
            <Stage3D
              modules={modules}
              url={src}
              onReady={onModelReady}
              sceneRef={sceneRef}
            />
          </ModelBoundary>
        ) : null}

        {stage === "loading" ? (
          // `role="status"` and not `aria-live="assertive"`: the reader pressed a button and is
          // waiting; they should be told once, politely, without being interrupted mid-sentence.
          <p
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-surface-100 p-6 text-center text-sm text-ink-500"
          >
            Loading the artefact…
          </p>
        ) : null}
      </div>

      <figcaption className="prose-measure mt-3 text-sm leading-relaxed text-ink-500">
        Drag to rotate the model and scroll to zoom. It is a scan of one object and is not a
        measurement — dimensions, materials and condition are recorded in the details above.
      </figcaption>
    </figure>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The canvas
// ─────────────────────────────────────────────────────────────────────────────

function Stage3D({
  modules,
  url,
  onReady,
  sceneRef
}: {
  modules: ViewerModules;
  url: string;
  onReady: () => void;
  sceneRef: { current: object | null };
}) {
  const { Canvas } = modules.fiber;
  const { OrbitControls } = modules.drei;

  return (
    <Canvas
      // A distance chosen against MODEL_SPAN, so every artefact opens at the same apparent size
      // whatever units it was authored in.
      camera={{ position: [MODEL_SPAN * 1.4, MODEL_SPAN * 0.9, MODEL_SPAN * 1.9], fov: 45 }}
      // Capped at 2: a 3× device pixel ratio quadruples the fragment cost for a difference nobody can
      // see on a 24rem canvas.
      dpr={[1, 2]}
      frameloop="demand"
      gl={{ antialias: true }}
      className="h-full w-full"
    >
      <ambientLight intensity={0.7} />
      {/* Two directionals rather than an environment map: a drei `<Environment preset>` fetches an
          HDR file from a third-party host, which is exactly the dependency the rest of this page
          avoids. Two lights are enough to read form on a matte object. */}
      <directionalLight position={[3, 4, 2]} intensity={1.1} />
      <directionalLight position={[-3, -1, -4]} intensity={0.35} />

      <OrbitControls
        makeDefault
        // See the header: damping is inertia, and inertia needs a frame loop this viewer does not run.
        enableDamping={false}
        // Panning can carry the artefact off screen with no way back but a reload. Rotation and zoom
        // reach every side of it and cannot lose it.
        enablePan={false}
        minDistance={MODEL_SPAN}
        maxDistance={MODEL_SPAN * 6}
      />

      {/* `fallback={null}` — the DOM overlay above says "Loading the artefact…", where it is real text
          rather than something drawn inside a canvas. */}
      <Suspense fallback={null}>
        <Model modules={modules} url={url} onReady={onReady} sceneRef={sceneRef} />
      </Suspense>
    </Canvas>
  );
}

function Model({
  modules,
  url,
  onReady,
  sceneRef
}: {
  modules: ViewerModules;
  url: string;
  onReady: () => void;
  sceneRef: { current: object | null };
}) {
  const { useGLTF } = modules.drei;
  const { useThree } = modules.fiber;
  const { Box3, Vector3 } = modules.three;

  // Suspends until the file is parsed; a failure throws to the boundary outside the canvas.
  // Draco and meshopt are both enabled explicitly — see the note in the file header about where the
  // Draco decoder comes from.
  const gltf = useGLTF(url, true, true);
  const invalidate = useThree((state) => state.invalidate);

  /**
   * Normalise the model into a known box.
   *
   * A glTF may be authored in millimetres, metres or arbitrary units, and its origin is often a corner
   * rather than the centre — so a fixed camera would frame one artefact perfectly and leave the next
   * one a dot or a wall. The bounding box is measured once and the group is scaled and offset so the
   * object's centre sits at the origin and its longest side is MODEL_SPAN.
   */
  const placement = useMemo(() => {
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    // A degenerate box (an empty scene, a single point) would divide by zero and scale to Infinity.
    const scale = longest > 0 ? MODEL_SPAN / longest : 1;
    return {
      scale,
      offset: [-centre.x * scale, -centre.y * scale, -centre.z * scale] as [number, number, number]
    };
  }, [Box3, Vector3, gltf.scene]);

  useEffect(() => {
    sceneRef.current = gltf.scene;
    onReady();
    // Under `frameloop="demand"` the arrival of the model is not by itself a reason for the renderer
    // to draw; without this the reader presses the button, the file downloads, and the canvas stays
    // empty until they happen to drag it.
    invalidate();
  }, [gltf.scene, invalidate, onReady, sceneRef]);

  return (
    <group scale={placement.scale} position={placement.offset}>
      {/*
        `dispose={null}` — the scene belongs to drei's suspense cache, not to this element. Letting
        R3F dispose it on unmount would free buffers the cache still hands out, and the next visit
        would render a model with no geometry. The teardown in Artifact3D disposes the tree AND clears
        the cache together, which is the only order that is safe.
      */}
      <primitive object={gltf.scene} dispose={null} />
    </group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────────────────────────────────────

interface ModelBoundaryProps {
  onFailure: () => void;
  children: ReactNode;
}

/**
 * The one class component in this file, because an error boundary can only be a class.
 *
 * It renders nothing on failure; the parent's `stage` becomes "modelFailed" and the parent renders the
 * explanation. Reporting through a callback rather than rendering its own message keeps every failure
 * sentence on this page in one place.
 */
class ModelBoundary extends Component<ModelBoundaryProps, { failed: boolean }> {
  constructor(props: ModelBoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // The reader gets a sentence; whoever has to fix the file gets the reason.
    console.error("[artifact3d] the model could not be loaded", error);
    this.props.onFailure();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ViewerFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-[16rem] items-center justify-center rounded-lg border border-dashed border-line-200 bg-surface-50",
        className
      )}
    >
      {children}
    </div>
  );
}

function Notice({
  icon: Icon,
  title,
  body,
  action
}: {
  icon: typeof TriangleAlert;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-surface-200 text-ink-500">
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>
      <p className="font-display text-base font-semibold text-ink-900">{title}</p>
      <p className="prose-measure text-sm leading-relaxed text-ink-500">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/**
 * Is there a WebGL context to be had?
 *
 * Tested before a megabyte of viewer is downloaded, so an old machine is told plainly instead of
 * spending the bandwidth and then failing. The probe context is released immediately: browsers cap
 * live contexts at around sixteen, and a test that quietly held one would count against the map on
 * the same page.
 */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!context) return false;
    if ("getExtension" in context) {
      const lose = context.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null;
      lose?.loseContext?.();
    }
    return true;
  } catch {
    // Some hardened browsers throw rather than return null from `getContext`.
    return false;
  }
}

/**
 * Release every GPU allocation under a scene.
 *
 * `renderer.dispose()` (which R3F calls on unmount) frees the context, not the buffers uploaded
 * through it, and `material.dispose()` does not touch the textures the material references. So the
 * tree is walked explicitly: geometry, then every material, then every texture hanging off each
 * material. Written against three's own classes — held from the dynamic import, never a static one —
 * so nothing here puts three.js into the page's bundle.
 */
function disposeTree(three: ThreeModule, root: object): void {
  if (!(root instanceof three.Object3D)) return;

  root.traverse((node) => {
    if (!(node instanceof three.Mesh)) return;

    const geometry: unknown = node.geometry;
    if (geometry instanceof three.BufferGeometry) geometry.dispose();

    const materials: unknown[] = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!(material instanceof three.Material)) continue;

      // A material's texture slots are ordinary properties, and which ones exist depends on the
      // material type — so every value is tested rather than a fixed list of names being read.
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof three.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
