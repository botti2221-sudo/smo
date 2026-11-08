import { system } from "@minecraft/server";
import { registerCharacter } from "../core/registry.js";
import { addModifiers, getStat } from "../core/stats.js";
import { dealDamage, enemiesNear, fireBeam, heal, spawnParticle, playSound } from "../core/combat.js";
import { V, center } from "../core/vec.js";

// タンク: 高 HP・高防御。味方の前に立って耐える
registerCharacter({
  id: "piccolo",
  name: "ピッコロ",
  role: "タンク",
  icon: "textures/items/slimeball",
  base: {
    hp: 1500,
    atkAll: 80,
    atkStrike: 20,
    atkEnergy: 15,
    defAll: 90,
    defStrike: 20,
    defEnergy: 20,
    speed: 95,
  },
  attack: {
    type: "strike",
    range: 3.5,
    normalPower: 0.55,
    rushPower: 0.22,
    interval: 4,
    rushTicks: 60,
    finisherPower: 1.0,
  },
  items: {
    fist: "gk:piccolo_fist",
    skill1: "gk:piccolo_skill1",
    skill2: "gk:piccolo_skill2",
    skill3: "gk:piccolo_skill3",
    ultimate: "gk:piccolo_ultimate",
  },
  skills: {
    skill1: {
      name: "魔貫光殺砲",
      desc: "1.5秒溜めて敵を貫く細いビームを放つ",
      cooldown: 220,
      cast(p, s, ctx) {
        const CHARGE = 30;
        s.castingUntil = system.currentTick + CHARGE + 2;
        addModifiers(p, "piccolo_s1_charge", { speed: -60 }, CHARGE);
        playSound(p.dimension, "mob.guardian.attack", p.location);
        let t = 0;
        const handle = system.runInterval(() => {
          if (!p.isValid) return system.clearRun(handle);
          const dir = p.getViewDirection();
          const tip = V.add(p.getHeadLocation(), V.add(V.scale(dir, 0.6), { x: 0, y: 0.2, z: 0 }));
          if (++t < CHARGE) {
            if (t % 2 === 0) spawnParticle(p.dimension, "minecraft:electric_spark_particle", tip);
            return;
          }
          system.clearRun(handle);
          playSound(p.dimension, "mob.warden.sonic_boom", p.location, { pitch: 1.6 });
          fireBeam(p, {
            origin: tip,
            dir,
            range: 28,
            radius: 0.6,
            particles: ["minecraft:endrod", "minecraft:electric_spark_particle"],
            visualTicks: 8,
            onHit(target) {
              dealDamage(p, target, { power: 3.0 * ctx.power, type: "energy", knockback: 1.2, lift: 0.2 });
            },
          });
        }, 1);
      },
    },
    skill2: {
      name: "再生",
      desc: "最大HPの25%を回復し、5秒間 全防御力アップ(30%)",
      cooldown: 360,
      cast(p, s, ctx) {
        heal(p, getStat(p, "hp") * 0.25 * ctx.power);
        addModifiers(p, "piccolo_regen", { defAll: 30 * ctx.power }, 100);
        playSound(p.dimension, "random.levelup", p.location, { pitch: 0.7 });
        for (let i = 0; i < 8; i++) {
          spawnParticle(p.dimension, "minecraft:villager_happy", V.add(p.location, { x: Math.random() - 0.5, y: Math.random() * 2, z: Math.random() - 0.5 }));
        }
      },
    },
    skill3: {
      name: "激烈光弾",
      desc: "周囲5ブロックの敵に気の爆発。吹き飛ばして移動速度ダウン(30%/2秒)",
      cooldown: 200,
      cast(p, s, ctx) {
        const c = center(p);
        spawnParticle(p.dimension, "minecraft:large_explosion", c);
        playSound(p.dimension, "random.explode", p.location, { volume: 0.7 });
        for (const e of enemiesNear(p, c, 5)) {
          dealDamage(p, e, { power: 1.2 * ctx.power, type: "energy", knockback: 1.4, lift: 0.4 });
          addModifiers(e, "piccolo_s3_slow", { speed: -30 }, 40);
        }
      },
    },
    ultimate: {
      name: "魔空包囲弾",
      desc: "視線の先(最大20ブロック)を無数の気弾で包囲し、範囲4ブロックの敵に連続ダメージ",
      cast(p, s, ctx) {
        // 着弾地点: 視線の先のブロック or 20 ブロック先
        const dir = p.getViewDirection();
        let dist = 20;
        try {
          const hit = p.getBlockFromViewDirection({ maxDistance: 20 });
          if (hit) dist = V.dist(p.getHeadLocation(), hit.block.location);
        } catch {}
        const spot = V.add(p.getHeadLocation(), V.scale(dir, dist));
        playSound(p.dimension, "mob.evocation_illager.cast_spell", p.location);
        let t = 0;
        const handle = system.runInterval(() => {
          if (!p.isValid) return system.clearRun(handle);
          t++;
          // 包囲: 着弾地点のまわりに気弾が集まる演出
          for (let i = 0; i < 3; i++) {
            const a = Math.random() * Math.PI * 2;
            spawnParticle(p.dimension, "minecraft:basic_flame_particle", V.add(spot, { x: Math.cos(a) * 4, y: Math.random() * 3, z: Math.sin(a) * 4 }));
          }
          // 15 tick 後から 5 tick ごとに 4 回爆発
          if (t >= 15 && t % 5 === 0) {
            spawnParticle(p.dimension, "minecraft:large_explosion", spot);
            playSound(p.dimension, "random.explode", spot, { volume: 0.5 });
            for (const e of enemiesNear(p, spot, 4)) {
              dealDamage(p, e, { power: 1.1 * ctx.power, type: "energy", lift: 0.1 });
              addModifiers(e, "piccolo_ult_slow", { speed: -30 }, 30);
            }
          }
          if (t >= 30) system.clearRun(handle);
        }, 1);
      },
    },
  },
  passive: {
    name: "ナメック星人の再生力",
    desc: "5秒間ダメージを受けていないと、毎秒最大HPの1.5%を回復",
    tick(p, s) {
      if (system.currentTick - (s.lastHurt ?? 0) > 100) heal(p, getStat(p, "hp") * 0.0075);
    },
  },
});
