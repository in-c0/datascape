import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import { config } from "../datascape.config.js";
import * as THREE from "three";
import { NODES } from "./data/nodes.js";
import { LAYOUTS } from "./topologies.js";
import { updateLeader } from "./leader.js";
import { nodeMatches, hasFilters } from "./spec.js";
import ThoughtCloud from "./ThoughtCloud.jsx";
import CreedDrift from "./CreedDrift.jsx";
import Becoming from "./instruments/Becoming.jsx";
import EraInscriptions from "./instruments/EraInscriptions.jsx";
import Metaperception from "./instruments/Metaperception.jsx";
import RarityShore from "./instruments/RarityShore.jsx";
import VizField from "./instruments/VizField.jsx";

const GOAL_POS = new THREE.Vector3();
const GOAL_TGT = new THREE.Vector3();

const N = NODES.length;
const INTRO_END = 3.4; // seconds: nodes rained in, camera settled, HUD fades up
const ORIGIN = new THREE.Vector3(0, 0, 0);

// theme targets ----------------------------------------------------------
const THEMES = {
  lab: {
    bg: new THREE.Color("#07080a"),
    edge: new THREE.Color("#ffffff"),
    edgeOpacity: 0.16,
    nodeBoost: 0.72, // toward white, keeping a whisper of category hue
    roughness: 0.55,
    scale: [0.16, 0.24, 0.36],
    light: 0.35,
    dust: new THREE.Color("#9aa39a"),
    dustOpacity: 0.5,
    mark: new THREE.Color("#eef1ee"),
  },
  candy: {
    bg: new THREE.Color("#f3e3ec"),
    edge: new THREE.Color("#2b2b38"),
    edgeOpacity: 0.55,
    nodeBoost: 0.0, // full category candy color
    roughness: 0.18,
    scale: [0.28, 0.4, 0.56],
    light: 1.0,
    dust: new THREE.Color("#b98aa5"),
    dustOpacity: 0.35,
    mark: new THREE.Color("#2b2b38"),
  },
};

const CANDY = {
  "voice & speech": "#7FDCB2",
  "ai products": "#CDEF4A",
  "agents & automation": "#8FB0FF",
  "creative & play": "#FF9EC6",
  "infra & tools": "#FFD37A",
};

const DUST_COUNT = 320;

export default function Scene({
  topology, theme, hovered, setHovered, focused, setFocused,
  openThought, setOpenThought, diveRef, telemetry, thoughts,
  rotateOK, interactRef, filters, cameraGoalRef, instruments, vizResult,
}) {
  const inst = useRef();
  const hoverDist = useRef(999); // camera→hovered-node distance, for label clamping
  const lines = useRef();
  const core = useRef();
  const group = useRef();
  const dust = useRef();
  const mark = useRef();
  const { scene } = useThree();
  const controls = useThree((s) => s.controls);

  const th = THEMES[theme];

  // simulation state ------------------------------------------------------
  const sim = useMemo(() => {
    // deterministic spawn shell far out in the fog: the intro rains in from here
    const seeded = (i) => {
      const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const spawn = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = seeded(i) * 2 - 1;
      const a = seeded(i + 100) * Math.PI * 2;
      const r = 22 + seeded(i + 200) * 8;
      const s = Math.sqrt(1 - u * u);
      spawn[i * 3] = r * s * Math.cos(a);
      spawn[i * 3 + 1] = r * u * 0.7;
      spawn[i * 3 + 2] = r * s * Math.sin(a);
    }
    return {
      spawn,
      cur: spawn.slice(),
      vel: new Float32Array(N * 3),
      color: NODES.map((n) => new THREE.Color(CANDY[n.category])),
      curScale: new Float32Array(N).fill(0.001),
      dummy: new THREE.Object3D(),
      tmpC: new THREE.Color(),
      white: new THREE.Color("#eef1ee"),
      wp: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      diveStart: null,
      driftAmt: 1,
    };
  }, []);

  // ambient dust field ------------------------------------------------------
  const dustPositions = useMemo(() => {
    const p = new Float32Array(DUST_COUNT * 3);
    let t = 53;
    const rnd = () => {
      t |= 0; t = (t + 0x6d2b79f5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < DUST_COUNT; i++) {
      p[i * 3] = (rnd() - 0.5) * 30;
      p[i * 3 + 1] = (rnd() - 0.5) * 16;
      p[i * 3 + 2] = (rnd() - 0.5) * 30;
    }
    return p;
  }, []);

  // floating wordmark, canvas-textured so it needs no font assets ----------
  const markTexture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 1600; c.height = 280;
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff";
    x.font = "700 168px 'Cascadia Code', Consolas, monospace";
    x.textAlign = "center";
    x.textBaseline = "middle";
    try { x.letterSpacing = "46px"; } catch { /* older engines */ }
    x.fillText(config.siteName.toUpperCase(), 800, 148);
    const tx = new THREE.CanvasTexture(c);
    tx.anisotropy = 4;
    return tx;
  }, []);

  const maxEdges = useMemo(
    () => Math.max(...Object.values(LAYOUTS).map((l) => l.edges.length)),
    []
  );
  const edgePositions = useMemo(() => new Float32Array(maxEdges * 6), [maxEdges]);

  useFrame((state, dt) => {
    const layout = LAYOUTS[topology];
    const t = state.clock.elapsedTime;
    const d = Math.min(dt, 0.05);
    const f = 1 - Math.exp(-5 * d);
    const intro = t < INTRO_END;
    const dive = focused != null ? Math.min(diveRef.current, 1) : 0;

    // background + fog toward theme; fog opens up over the strata terrain
    scene.background.lerp(th.bg, f);
    if (scene.fog) {
      scene.fog.color.lerp(th.bg, f);
      const fogNear = topology === "strata" ? 19 : 14;
      const fogFar = topology === "strata" ? 46 : 34;
      scene.fog.near += (fogNear - scene.fog.near) * f;
      scene.fog.far += (fogFar - scene.fog.far) * f;
    }

    // intro: camera glides in from the fog
    if (intro) {
      const len = state.camera.position.length();
      state.camera.position.setLength(len + (15.5 - len) * (1 - Math.exp(-1.4 * d)));
    }

    // dive: camera slides toward the focused thought
    if (focused != null && dive > 0.02) {
      sim.wp.set(sim.cur[focused * 3], sim.cur[focused * 3 + 1], sim.cur[focused * 3 + 2]);
      group.current.localToWorld(sim.wp);
      sim.dir.copy(state.camera.position).sub(sim.wp);
      const dist = sim.dir.length() || 1;
      if (sim.diveStart == null) sim.diveStart = dist;
      const e = dive * dive * (3 - 2 * dive); // smoothstep
      const targetDist = sim.diveStart + (1.25 - sim.diveStart) * e;
      state.camera.position.copy(sim.wp).addScaledVector(sim.dir.normalize(), targetDist);
      if (controls) controls.target.lerp(sim.wp, Math.min(1, 10 * d));
    } else {
      sim.diveStart = null;
      const goal = cameraGoalRef.current;
      if (goal && !intro) {
        // spec-driven camera: glide until the visitor's hand takes over
        const g = 1 - Math.exp(-2.2 * d);
        state.camera.position.lerp(GOAL_POS.set(...goal.pos), g);
        if (controls) controls.target.lerp(GOAL_TGT.set(...goal.target), g);
      } else if (controls && !goal && controls.target.lengthSq() > 0.0004) {
        controls.target.lerp(ORIGIN, f);
      }
    }

    // drift discipline: any interaction pauses the spin for 8s; open cards,
    // the page, and the HUD toggle hard-stop it (rotateOK comes from App).
    // the spin eases in and out instead of snapping — a slow wind-up when it
    // resumes, a soft brake when a hand arrives
    const drifting = rotateOK && performance.now() - interactRef.current > 8000;
    const ease = drifting ? 0.55 : 2.4;
    sim.driftAmt += ((drifting ? 1 : 0) - sim.driftAmt) * (1 - Math.exp(-ease * d));
    if (controls) {
      controls.autoRotate = sim.driftAmt > 0.004;
      controls.autoRotateSpeed = 0.35 * sim.driftAmt;
    }
    if (import.meta.env.DEV) window.__driftAmt = sim.driftAmt;

    // leader line from the docked card to the focused node
    if (focused != null) {
      sim.wp.set(sim.cur[focused * 3], sim.cur[focused * 3 + 1], sim.cur[focused * 3 + 2]);
      group.current.localToWorld(sim.wp);
      updateLeader(sim.wp, state.camera);
    }

    // nodes: staggered intro activation, then damped spring toward layout
    const filtering = hasFilters(filters);
    for (let i = 0; i < N; i++) {
      const active = t > 0.35 + i * 0.05;
      const tx = layout.pos[i][0];
      const ty = layout.pos[i][1] + Math.sin(t * 0.6 + i * 1.7) * 0.09;
      const tz = layout.pos[i][2];
      if (active) {
        for (let a = 0; a < 3; a++) {
          const target = a === 0 ? tx : a === 1 ? ty : tz;
          const idx = i * 3 + a;
          const k = 4.2, damp = 3.4;
          sim.vel[idx] += (target - sim.cur[idx]) * k * d;
          sim.vel[idx] *= Math.max(0, 1 - damp * d);
          sim.cur[idx] += sim.vel[idx] * d;
        }
      }

      const match = !filtering || nodeMatches(NODES[i], filters);
      const wf = (NODES[i].weight - 1) / 2; // weight is continuous 1..3
      let s = active ? th.scale[0] + (th.scale[2] - th.scale[0]) * wf : 0.001;
      if (!match) s *= 0.42; // filtered out: recede, don't vanish
      if (hovered === i) s *= 1.45;
      if (focused === i) s *= 1.7;
      sim.curScale[i] += (s - sim.curScale[i]) * Math.min(1, 8 * d);

      sim.dummy.position.set(sim.cur[i * 3], sim.cur[i * 3 + 1], sim.cur[i * 3 + 2]);
      sim.dummy.scale.setScalar(sim.curScale[i]);
      sim.dummy.updateMatrix();
      inst.current.setMatrixAt(i, sim.dummy.matrix);

      sim.tmpC.set(CANDY[NODES[i].category]);
      if (theme === "lab") sim.tmpC.lerp(sim.white, th.nodeBoost);
      if (theme === "lab" && (hovered === i || focused === i)) sim.tmpC.set("#d8ff3e");
      if (!match && hovered !== i && focused !== i) sim.tmpC.lerp(th.bg, 0.75);
      sim.color[i].lerp(sim.tmpC, Math.min(1, 10 * d));
      inst.current.setColorAt(i, sim.color[i]);
    }
    inst.current.instanceMatrix.needsUpdate = true;
    if (inst.current.instanceColor) inst.current.instanceColor.needsUpdate = true;

    // edges follow current node positions; they fade up after the rain-in
    const E = layout.edges.length;
    for (let e = 0; e < E; e++) {
      const [a, b] = layout.edges[e];
      const o = e * 6;
      if (a === -1) {
        edgePositions[o] = 0; edgePositions[o + 1] = 0; edgePositions[o + 2] = 0;
      } else {
        edgePositions[o] = sim.cur[a * 3];
        edgePositions[o + 1] = sim.cur[a * 3 + 1];
        edgePositions[o + 2] = sim.cur[a * 3 + 2];
      }
      edgePositions[o + 3] = sim.cur[b * 3];
      edgePositions[o + 4] = sim.cur[b * 3 + 1];
      edgePositions[o + 5] = sim.cur[b * 3 + 2];
    }
    const geo = lines.current.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.setDrawRange(0, E * 2);
    lines.current.material.color.lerp(th.edge, f);
    const edgeTarget = t < 2.3 ? 0 : th.edgeOpacity;
    lines.current.material.opacity += (edgeTarget - lines.current.material.opacity) * f;

    // core sphere only lives in "centralized"
    const coreTarget = topology === "centralized" && !intro ? 0.52 : 0.001;
    const cs = core.current.scale.x + (coreTarget - core.current.scale.x) * (1 - Math.exp(-8 * d));
    core.current.scale.setScalar(cs);
    core.current.rotation.y = t * 0.4;

    // dust drifts; wordmark breathes
    if (dust.current) {
      dust.current.rotation.y = t * 0.008;
      dust.current.material.color.lerp(th.dust, f);
      dust.current.material.opacity += (th.dustOpacity - dust.current.material.opacity) * f;
    }
    if (mark.current) {
      const mo = t < 1.2 ? 0 : 0.85;
      mark.current.material.opacity += (mo - mark.current.material.opacity) * f * 0.6;
      mark.current.material.color.lerp(th.mark, f);
      mark.current.position.y = 4.6 + Math.sin(t * 0.35) * 0.18;
    }

    // slow idle drift of the whole structure obeys the same discipline
    group.current.rotation.y += d * 0.03 * sim.driftAmt;

    // telemetry straight to DOM, skipping react re-renders
    if (telemetry.current) {
      const az = Math.atan2(state.camera.position.x, state.camera.position.z);
      const el = document.getElementById("hud-coords");
      if (el)
        el.textContent =
          "LON " + ((az * 180) / Math.PI).toFixed(2).padStart(7) +
          "  LAT " + state.camera.position.y.toFixed(2).padStart(6) +
          "  R " + state.camera.position.length().toFixed(1);
      const tm = document.getElementById("hud-time");
      if (tm) {
        const s = Math.floor(t);
        tm.textContent =
          "T+" + String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0") +
          ":" + String(Math.floor((t % 1) * 100)).padStart(2, "0");
      }
      const bar = document.getElementById("dive-bar");
      if (bar) bar.style.width = Math.round(dive * 100) + "%";
    }
  });

  const hoveredNode = hovered != null && hovered !== focused ? NODES[hovered] : null;

  return (
    <>
      <ambientLight intensity={0.5 + th.light * 0.4} />
      <directionalLight position={[6, 10, 4]} intensity={0.8 + th.light * 1.2} />
      <directionalLight position={[-8, -4, -6]} intensity={0.25} color="#ffd1e8" />

      {/* the name, floating in the field; thoughts drift across and occlude it */}
      <mesh ref={mark} position={[0, 4.6, -7]} rotation={[-0.04, 0, 0]}>
        <planeGeometry args={[11, 1.93]} />
        <meshBasicMaterial
          map={markTexture}
          transparent
          opacity={0}
          depthWrite={false}
          fog={false}
        />
      </mesh>

      <group ref={group}>
        <instancedMesh
          ref={inst}
          args={[undefined, undefined, N]}
          onPointerMove={(e) => {
            e.stopPropagation();
            hoverDist.current = e.distance;
            interactRef.current = performance.now(); // aiming — hold the spin
            setHovered(e.instanceId);
          }}
          onPointerOut={() => setHovered(null)}
          onClick={(e) => {
            if (e.delta > 5) return; // that was an orbit drag, not a click
            e.stopPropagation();
            setFocused(focused === e.instanceId ? null : e.instanceId);
          }}
        >
          <sphereGeometry args={[1, 32, 32]} />
          <meshPhysicalMaterial
            roughness={th.roughness}
            clearcoat={1}
            clearcoatRoughness={0.25}
          />
        </instancedMesh>

        <lineSegments ref={lines} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[edgePositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial transparent opacity={0} color="#ffffff" depthWrite={false} />
        </lineSegments>

        {/* ambient dust */}
        <points ref={dust} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[dustPositions, 3]} />
          </bufferGeometry>
          <pointsMaterial size={0.06} sizeAttenuation transparent opacity={0} depthWrite={false} />
        </points>

        {/* 3.5 years of conversations, as dot-matrix matter */}
        {thoughts && (
          <ThoughtCloud
            data={thoughts}
            topology={topology}
            theme={theme}
            nodeHovered={hovered}
            nodeFocused={focused}
            openThought={openThought}
            setOpenThought={setOpenThought}
            interactRef={interactRef}
            filters={filters}
          />
        )}

        {/* borrowed wisdom drifts between the clusters */}
        <CreedDrift theme={theme} />

        {/* the terrain's own instruments: the fan of futures + era inscriptions */}
        {thoughts && <Becoming thoughts={thoughts} topology={topology} theme={theme} />}
        {thoughts && <EraInscriptions thoughts={thoughts} topology={topology} theme={theme} />}

        {/* the generative canvas: instruments composed on demand */}
        {vizResult && <VizField result={vizResult} theme={theme} />}

        {/* mirror bodies mounted by spec — the panels' in-world forms */}
        {instruments?.includes("metaperception") && <Metaperception theme={theme} />}
        {instruments?.includes("rarity") && thoughts && (
          <RarityShore thoughts={thoughts} theme={theme} />
        )}

        {/* the core self, present in centralized topology */}
        <mesh ref={core}>
          <icosahedronGeometry args={[1, 1]} />
          <meshBasicMaterial wireframe color={theme === "lab" ? "#d8ff3e" : "#2b2b38"} />
        </mesh>

        {/* hover label — tiny mono annotation; distanceFactor clamped so it
            can't bloom over the screen when the node is near the camera */}
        {hoveredNode && (
          <Html
            position={[sim.cur[hovered * 3], sim.cur[hovered * 3 + 1] + 0.5, sim.cur[hovered * 3 + 2]]}
            style={{ pointerEvents: "none" }}
            center
            distanceFactor={Math.min(11, hoverDist.current * 1.4)}
          >
            <div className={`tag tag--${theme}`}>
              <span className="tag__title">{hoveredNode.title.toLowerCase()}</span>
              <span className="tag__cat">[{hoveredNode.category}]</span>
            </div>
          </Html>
        )}

      </group>

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.06}
        autoRotateSpeed={0.35}
        enableZoom={focused == null}
        minDistance={4}
        maxDistance={26}
      />
    </>
  );
}
