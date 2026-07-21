// Leader line between the docked card and its node in the scene.
// Called per-frame from useFrame; writes straight to DOM, skipping react.
export function updateLeader(worldPos, camera) {
  const line = document.getElementById("leader-line");
  const dot = document.getElementById("leader-dot");
  const card = document.getElementById("dock-card");
  if (!line || !dot || !card) return;

  worldPos.project(camera);
  const behind = worldPos.z > 1;
  const sx = (worldPos.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-worldPos.y * 0.5 + 0.5) * window.innerHeight;

  const r = card.getBoundingClientRect();
  // anchor = nearest point on the card's border to the node
  const ax = Math.max(r.left, Math.min(sx, r.right));
  const ay = Math.max(r.top, Math.min(sy, r.bottom));
  const inside = sx > r.left && sx < r.right && sy > r.top && sy < r.bottom;

  const hidden = behind || inside;
  line.style.opacity = hidden ? "0" : "1";
  dot.style.opacity = hidden ? "0" : "1";
  if (hidden) return;

  line.setAttribute("x1", ax.toFixed(1));
  line.setAttribute("y1", ay.toFixed(1));
  line.setAttribute("x2", sx.toFixed(1));
  line.setAttribute("y2", sy.toFixed(1));
  dot.setAttribute("cx", sx.toFixed(1));
  dot.setAttribute("cy", sy.toFixed(1));
}
