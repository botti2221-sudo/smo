export const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  len: (a) => Math.hypot(a.x, a.y, a.z),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  norm(a) {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  },
  // 水平方向だけの単位ベクトル
  flat(a) {
    const l = Math.hypot(a.x, a.z) || 1;
    return { x: a.x / l, y: 0, z: a.z / l };
  },
};

// エンティティの胴体あたりの座標
export const center = (e) => ({ x: e.location.x, y: e.location.y + 0.9, z: e.location.z });
