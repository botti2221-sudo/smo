import { system, EntityDamageCause } from "@minecraft/server";
import { getStat } from "./stats.js";
import { addGauge } from "./state.js";
import { isAlly } from "./team.js";
import { V, center } from "./vec.js";

const HIT_PARTICLE = "anni:hit1"; // 攻撃ヒット時 (sabaibaruRPG-RP から移植)
const EXCLUDE_TYPES = ["minecraft:item", "minecraft:xp_orb", "minecraft:arrow", "minecraft:painting", "minecraft:leash_knot"];
export const NO_ATTACK_TAG = "gk_noattack"; // このタグのエンティティは攻撃対象にならない (ドラゴンボール等)

// ダメージを与えた時の通知 (ゲキシンゲージ・ラストヒット記録など): fn(source, target, dmg)
const damageListeners = [];
export function onDamage(fn) {
  damageListeners.push(fn);
}

export function spawnParticle(dim, id, loc) {
  try {
    dim.spawnParticle(id, loc);
  } catch {}
}

export function playSound(dim, id, loc, options) {
  try {
    dim.playSound(id, loc, options);
  } catch {}
}

function isAttackable(e) {
  if (!e?.isValid || !e.getComponent("minecraft:health") || e.hasTag(NO_ATTACK_TAG)) return false;
  if (e.typeId === "minecraft:player") {
    const mode = String(e.getGameMode()).toLowerCase();
    if (mode === "creative" || mode === "spectator") return false;
  }
  return true;
}

// 攻撃できる相手か (自分・味方チーム・無敵は除外)
export function isValidTarget(source, e) {
  if (!isAttackable(e) || e.id === source.id) return false;
  return !isAlly(source, e);
}

// ブロックが通り抜けられるか（空気・液体）
export function isPassable(dim, loc) {
  try {
    const b = dim.getBlock(loc);
    return !b || b.isAir || b.isLiquid;
  } catch {
    return false;
  }
}

// ダメージ = 威力 × (全攻撃力 + 打撃/エネルギー攻撃力) × 100 / (100 + 全防御力 + 打撃/エネルギー防御力)
export function calcDamage(source, target, power, type) {
  const atk = getStat(source, "atkAll") + getStat(source, type === "energy" ? "atkEnergy" : "atkStrike");
  const def = getStat(target, "defAll") + getStat(target, type === "energy" ? "defEnergy" : "defStrike");
  return (power * atk * 100) / (100 + def);
}

// ステータス上の HP ダメージを体力に換算して減らす（無敵時間を無視してラッシュが入るように直接減算）
function applyHpDamage(source, target, dmg) {
  const health = target.getComponent("minecraft:health");
  const hearts = (dmg * health.effectiveMax) / Math.max(1, getStat(target, "hp"));
  const next = health.currentValue - hearts;
  for (const fn of damageListeners) {
    try {
      fn(source, target, dmg);
    } catch {}
  }
  try {
    if (next <= 0) {
      target.applyDamage(health.effectiveMax * 10 + 100, { cause: EntityDamageCause.entityAttack, damagingEntity: source });
    } else {
      health.setCurrentValue(next);
    }
  } catch {}
}

// type: "strike"(打撃) | "energy"(エネルギー)
export function dealDamage(source, target, { power, type = "strike", knockback = 0, lift = 0 }) {
  if (!source.isValid || !isValidTarget(source, target)) return 0;
  const dmg = calcDamage(source, target, power, type);
  applyHpDamage(source, target, dmg);
  spawnParticle(target.dimension, HIT_PARTICLE, center(target));
  if (knockback > 0 || lift > 0) {
    const d = V.flat(V.sub(target.location, source.location));
    try {
      target.applyKnockback({ x: d.x * knockback, z: d.z * knockback }, lift);
    } catch {}
  }
  if (source.typeId === "minecraft:player") addGauge(source, dmg / 15);
  if (target.typeId === "minecraft:player") addGauge(target, dmg / 30);
  return dmg;
}

// 防御を無視した固定ダメージ (ゲキシンバースト等)。hpAmount はステータス上の HP
export function dealTrueDamage(source, target, hpAmount) {
  if (!source.isValid || !isValidTarget(source, target)) return 0;
  applyHpDamage(source, target, hpAmount);
  spawnParticle(target.dimension, HIT_PARTICLE, center(target));
  return hpAmount;
}

// 回復。hpAmount はステータス上の HP
export function heal(target, hpAmount) {
  const health = target.getComponent("minecraft:health");
  if (!health || health.currentValue <= 0) return;
  const hearts = (hpAmount * health.effectiveMax) / Math.max(1, getStat(target, "hp"));
  health.setCurrentValue(Math.min(health.effectiveMax, health.currentValue + hearts));
}

// 範囲内の敵 / 味方(自分を含む)
export function enemiesNear(source, pos, radius) {
  try {
    return source.dimension
      .getEntities({ location: pos, maxDistance: radius + 1, excludeTypes: EXCLUDE_TYPES })
      .filter((e) => isValidTarget(source, e) && V.dist(center(e), pos) <= radius + 0.5);
  } catch {
    return [];
  }
}

export function alliesNear(source, pos, radius) {
  try {
    return source.dimension
      .getEntities({ location: pos, maxDistance: radius, type: "minecraft:player" })
      .filter((e) => isAttackable(e) && isAlly(source, e));
  } catch {
    return [];
  }
}

// 視線の前方 range 以内で一番近い相手
export function findTarget(source, range, minDot = 0.75) {
  const origin = source.getHeadLocation();
  const dir = source.getViewDirection();
  let best;
  let bestDist = Infinity;
  for (const e of source.dimension.getEntities({ location: source.location, maxDistance: range + 2, excludeTypes: EXCLUDE_TYPES })) {
    if (!isValidTarget(source, e)) continue;
    const to = V.sub(center(e), origin);
    const d = V.len(to);
    if (d > range + 0.5) continue;
    if (d > 1 && V.dot(V.norm(to), dir) < minDot) continue;
    if (d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

function entitiesNear(source, dim, pos, radius) {
  try {
    return dim
      .getEntities({ location: pos, maxDistance: radius + 1.5, excludeTypes: EXCLUDE_TYPES })
      .filter((e) => isValidTarget(source, e) && V.dist(center(e), pos) <= radius + 0.7);
  } catch {
    return [];
  }
}

// スクリプトで動かす弾。最初に当たった相手に onHit(target, pos)
// particle: 毎ステップ出すパーティクル / onTick(pos, tick): 1 tick ごとの演出 / onEnd(pos): 壁・射程切れ
// pierce: true なら当たっても止まらず貫通 (同じ相手には 1 回だけ当たる)
export function launchProjectile(source, { origin, dir, speed = 1.5, range = 20, radius = 0.6, pierce = false, particle, onTick, onEnd, onHit }) {
  const dim = source.dimension;
  const steps = Math.max(1, Math.ceil(speed / 0.5));
  const step = V.scale(dir, speed / steps);
  const alreadyHit = new Set();
  let pos = { ...origin };
  let traveled = 0;
  let tick = 0;
  const handle = system.runInterval(() => {
    if (!source.isValid) return system.clearRun(handle);
    onTick?.(pos, tick++);
    for (let i = 0; i < steps; i++) {
      pos = V.add(pos, step);
      traveled += speed / steps;
      if (traveled > range || !isPassable(dim, pos)) {
        if (onEnd) onEnd(pos);
        else spawnParticle(dim, "minecraft:critical_hit_emitter", pos);
        return system.clearRun(handle);
      }
      if (particle) spawnParticle(dim, particle, pos);
      if (pierce) {
        for (const e of entitiesNear(source, dim, pos, radius)) {
          if (alreadyHit.has(e.id)) continue;
          alreadyHit.add(e.id);
          onHit(e, pos);
        }
        continue;
      }
      const hit = entitiesNear(source, dim, pos, radius)[0];
      if (hit) {
        system.clearRun(handle);
        onHit(hit, pos);
        return;
      }
    }
  }, 1);
}

// 一直線のビーム。ブロックで止まり、線上の全員に onHit(target)
export function fireBeam(source, { origin, dir, range, radius, particles, visualTicks = 10, onHit }) {
  const dim = source.dimension;
  let length = 0;
  while (length < range && isPassable(dim, V.add(origin, V.scale(dir, length)))) length += 0.5;
  const end = V.add(origin, V.scale(dir, length));
  const mid = V.add(origin, V.scale(dir, length / 2));

  const hits = [];
  try {
    for (const e of dim.getEntities({ location: mid, maxDistance: length / 2 + radius + 2, excludeTypes: EXCLUDE_TYPES })) {
      if (!isValidTarget(source, e)) continue;
      const c = center(e);
      const t = Math.max(0, Math.min(length, V.dot(V.sub(c, origin), dir)));
      if (V.dist(c, V.add(origin, V.scale(dir, t))) <= radius + 0.6) hits.push(e);
    }
  } catch {}
  for (const e of hits) onHit(e);

  let tick = 0;
  const handle = system.runInterval(() => {
    for (let d = 0; d < length; d += 0.8) {
      const p = V.add(origin, V.scale(dir, d));
      for (const id of particles) spawnParticle(dim, id, p);
    }
    if (tick % 4 === 0) spawnParticle(dim, "minecraft:large_explosion", end);
    if (++tick >= visualTicks) system.clearRun(handle);
  }, 1);
  return { end, hits };
}
