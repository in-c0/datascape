// VizField — where composed instruments materialize. The navigator (or a
// featured answer) hands over a viz clause; the engine runs it over real
// data; this renders the result INSIDE the scene, in the landscape's own
// language: hairline geometry, inscription labels, one accent. A chart that
// didn't exist a second ago, standing in the field.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";

const W = 10, H = 3.6, POS = [0, 5.6, 2.5];

export default function VizField({ result, theme }) {
  const g = useRef();

  const built = useMemo(() => {
    if (!result || !result.rows?.length) return null;
    const rows = result.rows;
    const ys = rows.map((r) => r.y);
    const yMax = Math.max(...ys), yMin = Math.min(0, Math.min(...ys));
    const span = yMax - yMin || 1;
    const px = (i) => -W / 2 + (rows.length === 1 ? W / 2 : (i / (rows.length - 1)) * W);
    const py = (y) => ((y - yMin) / span) * H;
    const pts = rows.map((r, i) => [px(i), py(r.y), 0]);

    const segs = [];
    // baseline + y-axis ticks
    segs.push(-W / 2, 0, 0, W / 2 + 0.4, 0, 0);
    segs.push(-W / 2, 0, 0, -W / 2, H + 0.2, 0);
    if (result.form === "curve") {
      for (let i = 0; i < pts.length - 1; i++) segs.push(...pts[i], ...pts[i + 1]);
    } else if (result.form === "bars") {
      pts.forEach(([x, y]) => segs.push(x, 0, 0, x, y, 0));
    }
    return {
      segs: new Float32Array(segs),
      scatter: new Float32Array(pts.flat()),
      yMax, yMin,
      first: rows[0], last: rows[rows.length - 1],
      peak: rows.reduce((a, r) => (r.y > a.y ? r : a), rows[0]),
      peakPos: pts[rows.findIndex((r) => r.y === Math.max(...ys))],
      barLabels:
        result.form === "bars" && rows.length <= 14
          ? rows.map((r, i) => ({ label: r.label, x: px(i) }))
          : [],
    };
  }, [result]);

  useFrame((state, dt) => {
    if (!g.current) return;
    const d = Math.min(dt, 0.05);
    g.current.position.y = POS[1] + Math.sin(state.clock.elapsedTime * 0.3) * 0.08;
    g.current.children.forEach((c) => {
      if (c.material && c.userData.op != null)
        c.material.opacity += (c.userData.op - c.material.opacity) * (1 - Math.exp(-3.5 * d));
    });
  });

  if (!built) return null;
  const ink = theme === "lab" ? "#eef1ee" : "#2b2b38";
  const lime = theme === "lab" ? "#d8ff3e" : "#2b2b38";

  return (
    <group ref={g} name="viz-field" position={POS}>
      <lineSegments frustumCulled={false} userData={{ op: result.form === "bars" ? 0.75 : 0.8 }}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[built.segs, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={result.form === "curve" ? lime : ink} transparent opacity={0} depthWrite={false} />
      </lineSegments>
      <points frustumCulled={false} userData={{ op: 0.9 }}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[built.scatter, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.09} sizeAttenuation color={lime} transparent opacity={0} depthWrite={false} />
      </points>

      <Html position={[0, H + 0.9, 0]} center distanceFactor={11} style={{ pointerEvents: "none" }} zIndexRange={[31, 0]}>
        <div className={`inscribe inscribe--${theme}`}>
          <span className="inscribe__t">{result.title}</span>
          <span className="inscribe__s">
            {result.yLabel} by {result.xLabel} · composed just now · {result.tier}
          </span>
        </div>
      </Html>
      <Html position={[-W / 2 - 0.7, H, 0]} center distanceFactor={9} style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
        <div className={`inscribe inscribe--${theme} inscribe--dim`}>
          <span className="inscribe__t">{built.yMax.toLocaleString()}</span>
        </div>
      </Html>
      <Html position={[-W / 2, -0.5, 0]} center distanceFactor={9} style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
        <div className={`inscribe inscribe--${theme} inscribe--dim`}>
          <span className="inscribe__t">{built.first.label}</span>
        </div>
      </Html>
      <Html position={[W / 2, -0.5, 0]} center distanceFactor={9} style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
        <div className={`inscribe inscribe--${theme} inscribe--dim`}>
          <span className="inscribe__t">{built.last.label}</span>
        </div>
      </Html>
      {built.peakPos && (
        <Html position={[built.peakPos[0], built.peakPos[1] + 0.45, 0]} center distanceFactor={9} style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
          <div className={`inscribe inscribe--${theme}`}>
            <span className="inscribe__t">{built.peak.label}</span>
            <span className="inscribe__s">{built.peak.y.toLocaleString()}</span>
          </div>
        </Html>
      )}
      {built.barLabels.map((b, i) => (
        <Html key={i} position={[b.x, -0.95 - (i % 2) * 0.55, 0]} center distanceFactor={8} style={{ pointerEvents: "none" }} zIndexRange={[29, 0]}>
          <div className={`inscribe inscribe--${theme} inscribe--dim`}>
            <span className="inscribe__t">{b.label}</span>
          </div>
        </Html>
      ))}
    </group>
  );
}
