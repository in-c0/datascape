import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { monthZ } from "./topologies.js";
import { updateLeader } from "./leader.js";
import { thoughtMatches, hasFilters } from "./spec.js";
import { seedQueue } from "./seeds.js";
import { SURFACE } from "./data/nodes.js";

// 3,492 conversations as a dot-matrix point cloud. Two shapes:
//  - nebula: the tf-idf embedding, thoughts drift near what they mean
//  - terrain: monthly ridges, height = how hard that month thought
// Provenance: hovering/focusing a project lights up the conversations
// that built it. Clicking a dot opens the listen-in card, docked in App.
const CLOUD_THEMES = {
  lab: {
    opacity: 0.7,
    size: 0.062,
    base: new THREE.Color("#c9d4c9"),
    korean: new THREE.Color("#e3b6c9"),
    lit: new THREE.Color("#d8ff3e"),
    dim: new THREE.Color("#3c423c"),
  },
  candy: {
    opacity: 0.45,
    size: 0.06,
    base: new THREE.Color("#96637e"),
    korean: new THREE.Color("#c25a8a"),
    lit: new THREE.Color("#2b2b38"),
    dim: new THREE.Color("#d8bccb"),
  },
};

const hash = (i, s) => {
  const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const leaderPos = new THREE.Vector3();

export default function ThoughtCloud({
  data, topology, theme, nodeHovered, nodeFocused,
  openThought, setOpenThought, interactRef, filters,
}) {
  const points = useRef();
  const whisperDist = useRef(999); // camera→dot distance, for label clamping
  const rotY = useRef(0); // accumulated ambient spin, so it can freeze
  const [hoveredThought, setHoveredThought] = useState(null);
  const th = CLOUD_THEMES[theme];
  const n = data.thoughts.length;

  useEffect(() => {
    setHoveredThought(null);
  }, [topology]);

  const sim = useMemo(() => {
    const nebula = new Float32Array(n * 3);
    const terrain = new Float32Array(n * 3);

    const S = 5.4;
    data.thoughts.forEach((t, i) => {
      nebula[i * 3] = t.p[0] * S;
      nebula[i * 3 + 1] = t.p[1] * S * 0.72;
      nebula[i * 3 + 2] = t.p[2] * S;
    });

    const counts = Object.fromEntries(data.meta.months);
    const maxCount = Math.max(...data.meta.months.map(([, c]) => c));
    const perMonthSeen = {};
    data.thoughts.forEach((t, i) => {
      const k = (perMonthSeen[t.m] = (perMonthSeen[t.m] || 0) + 1);
      const total = counts[t.m] || 1;
      const fx = total > 1 ? (k - 1) / (total - 1) : 0.5;
      const x = (fx * 2 - 1) * 8 + (hash(i, 1) - 0.5) * 0.55;
      const h = Math.pow((counts[t.m] || 0) / maxCount, 0.7) * 4.2;
      const bell = Math.exp(-((fx * 2 - 1) ** 2) * 2.2);
      terrain[i * 3] = x;
      terrain[i * 3 + 1] =
        -3.7 + h * bell * (0.22 + 0.78 * hash(i, 2) ** 2) + Math.sin(x * 0.9) * 0.12;
      terrain[i * 3 + 2] = monthZ(t.m) + (hash(i, 3) - 0.5) * 0.18;
    });

    return {
      nebula,
      terrain,
      cur: nebula.slice(),
      colors: new Float32Array(n * 3).fill(0.8),
      colorTargets: new Float32Array(n * 3).fill(0.8),
    };
  }, [data, n]);

  // recompute color targets when theme / provenance highlight changes
  const litProject = nodeHovered ?? nodeFocused;
  useEffect(() => {
    const tmp = new THREE.Color();
    const anyLit = litProject != null;
    const filtering = hasFilters(filters);
    for (let i = 0; i < n; i++) {
      const t = data.thoughts[i];
      const isLit = (anyLit && t.pj === litProject) || openThought === i;
      const cut = filtering && !thoughtMatches(t, filters);
      if (isLit) tmp.copy(th.lit);
      else if (anyLit || cut) tmp.copy(th.dim); // recede so the signal reads
      else tmp.copy(t.k ? th.korean : th.base);
      sim.colorTargets[i * 3] = tmp.r;
      sim.colorTargets[i * 3 + 1] = tmp.g;
      sim.colorTargets[i * 3 + 2] = tmp.b;
    }
  }, [litProject, openThought, theme, data, n, sim, th, filters]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    const f = 1 - Math.exp(-5 * d);
    const target = topology === "strata" ? sim.terrain : sim.nebula;
    const cur = sim.cur;
    const lerp = Math.min(1, 2.6 * d);
    for (let i = 0; i < cur.length; i++) cur[i] += (target[i] - cur[i]) * lerp;

    const cl = Math.min(1, 7 * d);
    for (let i = 0; i < sim.colors.length; i++)
      sim.colors[i] += (sim.colorTargets[i] - sim.colors[i]) * cl;

    const geo = points.current.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;

    const mat = points.current.material;
    mat.opacity += (th.opacity - mat.opacity) * f;
    mat.size += (th.size - mat.size) * f;
    // ambient spin freezes while aiming at or reading a dot — otherwise the
    // dot under the cursor drifts between hover and click
    if (hoveredThought == null && openThought == null && topology !== "strata")
      rotY.current += d * 0.004;
    points.current.rotation.y = topology === "strata" ? 0 : rotY.current;

    // leader line from the docked listen-in card to the open dot
    if (openThought != null) {
      leaderPos.set(
        sim.cur[openThought * 3],
        sim.cur[openThought * 3 + 1],
        sim.cur[openThought * 3 + 2]
      );
      points.current.localToWorld(leaderPos);
      updateLeader(leaderPos, state.camera);
    }
  });

  // seed glyphs — seeds are growing things, not spheres: a sprout rises from
  // each candidate dot so the garden is visible in the landscape itself
  const glyphs = useMemo(
    () => (SURFACE === "public" ? [] : seedQueue(data, 12).map(({ i }) => i)),
    [data]
  );
  const glyphGeom = useMemo(
    () => ({ pos: new Float32Array(glyphs.length * 4 * 6) }),
    [glyphs]
  );
  const glyphLines = useRef();
  useFrame((state) => {
    if (!glyphLines.current || !glyphs.length) return;
    const t = state.clock.elapsedTime;
    const p = glyphGeom.pos;
    glyphs.forEach((idx, k) => {
      const x = sim.cur[idx * 3], y = sim.cur[idx * 3 + 1], z = sim.cur[idx * 3 + 2];
      const grow = 0.55 + Math.sin(t * 0.5 + k * 1.3) * 0.06; // alive, breathing
      const sway = Math.sin(t * 0.7 + k) * 0.05;
      const o = k * 24;
      // stem, two segments with a bend
      p.set([x, y, z, x + sway * 0.4, y + grow * 0.55, z], o);
      p.set([x + sway * 0.4, y + grow * 0.55, z, x + sway, y + grow, z], o + 6);
      // two leaves near the tip
      p.set([x + sway * 0.6, y + grow * 0.7, z, x + sway * 0.6 + 0.14, y + grow * 0.82, z + 0.05], o + 12);
      p.set([x + sway * 0.6, y + grow * 0.7, z, x + sway * 0.6 - 0.12, y + grow * 0.8, z - 0.05], o + 18);
    });
    glyphLines.current.geometry.attributes.position.needsUpdate = true;
  });

  const showTag = hoveredThought != null && nodeHovered == null && openThought == null;
  const ht = showTag ? data.thoughts[hoveredThought] : null;

  return (
    <>
      <points
        ref={points}
        frustumCulled={false}
        onPointerMove={(e) => {
          if (e.index == null) return;
          // a project sphere anywhere along the ray owns the pointer — dots
          // are ambient matter and must never block aiming at a ball
          if (e.intersections.some((h) => h.object.isInstancedMesh)) {
            setHoveredThought(null);
            return;
          }
          whisperDist.current = e.distance;
          interactRef.current = performance.now(); // aiming — hold the spin
          setHoveredThought(e.index);
        }}
        onPointerOut={() => setHoveredThought(null)}
        onClick={(e) => {
          if (e.index == null) return;
          if (e.delta > 5) return; // that was an orbit drag, not a click
          // balls always win: dots only take clicks in empty space
          if (e.intersections.some((h) => h.object.isInstancedMesh)) return;
          e.stopPropagation();
          // open the dot whose whisper is showing — what you read is what opens
          const idx = hoveredThought ?? e.index;
          setOpenThought(openThought === idx ? null : idx);
        }}
      >
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[sim.cur, 3]} />
          <bufferAttribute attach="attributes-color" args={[sim.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.05}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0}
          depthWrite={false}
        />
      </points>

      {glyphs.length > 0 && (
        <lineSegments ref={glyphLines} name="seed-glyphs" frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[glyphGeom.pos, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            color={theme === "lab" ? "#8fdc7f" : "#5a8a4f"}
            transparent
            opacity={0.55}
            depthWrite={false}
          />
        </lineSegments>
      )}

      {ht && (
        <Html
          position={[
            sim.cur[hoveredThought * 3],
            sim.cur[hoveredThought * 3 + 1] + 0.32,
            sim.cur[hoveredThought * 3 + 2],
          ]}
          style={{ pointerEvents: "none" }}
          center
          distanceFactor={Math.min(10, whisperDist.current * 1.4)}
          zIndexRange={[35, 0]}
        >
          <div className={`whisper whisper--${theme}`}>
            <span className="whisper__title">{ht.t.toLowerCase()}</span>
            {ht.tk && <span className="whisper__hangul">{ht.tk}</span>}
            <span className="whisper__meta">{ht.m} · {ht.n} msgs · click to listen</span>
          </div>
        </Html>
      )}
    </>
  );
}
