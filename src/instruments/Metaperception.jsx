// Metaperception — the three-way structure from her first directive: how she
// presents · how she suspects she's seen · how the data reads her. Three
// bodies in slow orbit; the DISAGREEMENTS between them are the artifact,
// drawn as labeled tension lines. Speculative tier; limits on the mirror page.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { store } from "../store.js";

const MIRRORS = store.mirrors;

const BODIES = [
  { key: "presents", label: "as presented", short: MIRRORS.metaperception.how_she_presents },
  { key: "suspects", label: "as suspected to be seen", short: MIRRORS.metaperception.how_she_suspects_shes_seen },
  { key: "data", label: "as the data reads it", short: MIRRORS.metaperception.how_the_data_reads_her },
];
const TENSIONS = [
  [0, 2, MIRRORS.metaperception.tensions.presents_data],
  [0, 1, MIRRORS.metaperception.tensions.presents_suspects],
  [1, 2, MIRRORS.metaperception.tensions.suspects_data],
];
const R = 2.6, Y = 2.2;

export default function Metaperception({ theme }) {
  const g = useRef();
  const lines = useRef();

  const linePos = useMemo(() => new Float32Array(TENSIONS.length * 6), []);
  const bodyPos = (i, t) => {
    const a = (i / 3) * Math.PI * 2 + t * 0.06;
    return [Math.cos(a) * R, Y + Math.sin(t * 0.3 + i * 2.1) * 0.25, Math.sin(a) * R];
  };

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (!g.current) return;
    const ps = [0, 1, 2].map((i) => bodyPos(i, t));
    g.current.children.forEach((c, i) => {
      if (c.userData.body != null) {
        const p = ps[c.userData.body];
        c.position.set(p[0], p[1], p[2]);
      }
    });
    TENSIONS.forEach(([a, b], i) => {
      linePos.set([...ps[a], ...ps[b]], i * 6);
    });
    if (lines.current) lines.current.geometry.attributes.position.needsUpdate = true;
  });

  const ink = theme === "lab" ? "#eef1ee" : "#2b2b38";
  const lime = theme === "lab" ? "#d8ff3e" : "#2b2b38";
  const t0 = performance.now() / 1000;
  const mid = (i) => {
    const [a, b] = TENSIONS[i];
    const pa = bodyPos(a, t0), pb = bodyPos(b, t0);
    return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2 + 0.2, (pa[2] + pb[2]) / 2];
  };

  return (
    <group name="metaperception">
      <group ref={g}>
        {BODIES.map((b, i) => (
          <group key={b.key} userData={{ body: i }} position={bodyPos(i, t0)}>
            <mesh>
              <sphereGeometry args={[0.14, 20, 20]} />
              <meshBasicMaterial color={i === 2 ? lime : ink} transparent opacity={0.9} />
            </mesh>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.26, 0.008, 8, 40]} />
              <meshBasicMaterial color={ink} transparent opacity={0.4} />
            </mesh>
            <Html position={[0, 0.5, 0]} center distanceFactor={11} style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
              <div className={`inscribe inscribe--${theme}`}>
                <span className="inscribe__t">{b.label}</span>
                <span className="inscribe__s inscribe__s--wrap">{b.short.split("—")[0].split(":")[0]}</span>
              </div>
            </Html>
          </group>
        ))}
      </group>
      <lineSegments ref={lines} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[linePos, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={ink} transparent opacity={0.3} depthWrite={false} />
      </lineSegments>
      {TENSIONS.map(([, , text], i) => (
        <Html key={i} position={mid(i)} center distanceFactor={13} style={{ pointerEvents: "none" }} zIndexRange={[29, 0]}>
          <div className={`inscribe inscribe--${theme} inscribe--dim`}>
            <span className="inscribe__t">{text}</span>
          </div>
        </Html>
      ))}
    </group>
  );
}
