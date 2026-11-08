import { world } from "@minecraft/server";

// マップ上の地点。ワールドの dynamic property に JSON で保存
const KEY = "gk:locations";

export const LOCATION_NAMES = {
  lobby: "ロビー",
  baseA: "チームA 自陣 (出撃・復活地点)",
  baseB: "チームB 自陣 (出撃・復活地点)",
  hakaishinA_top: "チームAの破壊神 (上レーン)",
  hakaishinA_bottom: "チームAの破壊神 (下レーン)",
  hakaishinA_core: "チームAの破壊神 (ドラゴンボールの前)",
  hakaishinB_top: "チームBの破壊神 (上レーン)",
  hakaishinB_bottom: "チームBの破壊神 (下レーン)",
  hakaishinB_core: "チームBの破壊神 (ドラゴンボールの前)",
  dragonballA: "チームAのドラゴンボール (最奥)",
  dragonballB: "チームBのドラゴンボール (最奥)",
  boss: "ボス出現地点 (中央)",
};

// 破壊神の配置 (チームごとに 3 体)
export const HAKAISHIN_SLOTS = ["top", "bottom", "core"];

let cache;
function data() {
  if (!cache) {
    try {
      cache = JSON.parse(world.getDynamicProperty(KEY) ?? "{}");
    } catch {
      cache = {};
    }
    cache.npc ??= [];
  }
  return cache;
}

function save() {
  world.setDynamicProperty(KEY, JSON.stringify(data()));
}

const round = (l) => ({ x: Math.floor(l.x) + 0.5, y: Math.floor(l.y), z: Math.floor(l.z) + 0.5 });

export const getLoc = (key) => data()[key];
export const getNpcPoints = () => data().npc;
export const missingLocations = () => Object.keys(LOCATION_NAMES).filter((k) => !data()[k]);

export function setLoc(key, loc) {
  data()[key] = round(loc);
  save();
}

export function addNpcPoint(loc) {
  data().npc.push(round(loc));
  save();
}

export function clearNpcPoints() {
  data().npc = [];
  save();
}

// テスト用: 今いる場所をロビーにして、向いている方向に 2 レーン (上・下) のマップの全地点を自動配置
//
//   [DB-A][破壊神A core][自陣A] ─ 上レーン: 破壊神A上 … NPC … 破壊神B上 ─ [自陣B][破壊神B core][DB-B]
//                              ─ 中央: ボス                               ─
//                              ─ 下レーン: 破壊神A下 … NPC … 破壊神B下 ─
export function autoSetup(player) {
  const v = player.getViewDirection();
  // 向きを東西南北に丸める
  const d = Math.abs(v.x) >= Math.abs(v.z) ? { x: Math.sign(v.x) || 1, z: 0 } : { x: 0, z: Math.sign(v.z) || 1 };
  const side = { x: -d.z, z: d.x };
  const o = player.location;
  const c = { x: o.x + d.x * 90, y: o.y, z: o.z + d.z * 90 }; // 中央
  const at = (along, across = 0) => ({ x: c.x + d.x * along + side.x * across, y: c.y, z: c.z + d.z * along + side.z * across });
  const LANE = 18; // レーンの中央からの距離

  const d0 = data();
  d0.lobby = round(o);
  for (const [t, sign] of [["A", -1], ["B", 1]]) {
    d0[`dragonball${t}`] = round(at(sign * 75));
    d0[`hakaishin${t}_core`] = round(at(sign * 70));
    d0[`base${t}`] = round(at(sign * 62));
    d0[`hakaishin${t}_top`] = round(at(sign * 38, -LANE));
    d0[`hakaishin${t}_bottom`] = round(at(sign * 38, LANE));
  }
  d0.boss = round(at(0));
  d0.npc = [round(at(-15, -LANE)), round(at(15, -LANE)), round(at(-15, LANE)), round(at(15, LANE))];
  delete d0.hakaishinA;
  delete d0.hakaishinB;
  save();
}

export function locationsText() {
  const d0 = data();
  const fmt = (l) => (l ? `§a${Math.floor(l.x)}, ${Math.floor(l.y)}, ${Math.floor(l.z)}` : "§c未設定");
  const lines = Object.entries(LOCATION_NAMES).map(([k, name]) => `§f${name} §7(${k}): ${fmt(d0[k])}`);
  lines.push(`§fNPC出現地点: §e${d0.npc.length}か所`);
  return lines.join("\n");
}
