import { system } from "@minecraft/server";
import { registerCharacter } from "../core/registry.js";
import { addModifiers, getStat } from "../core/stats.js";
import { alliesNear, dealDamage, enemiesNear, heal, launchProjectile, spawnParticle, playSound } from "../core/combat.js";
import { V, center } from "../core/vec.js";

// テクニカル: 回復・妨害で味方を支援
registerCharacter({
  id: "krillin",
  name: "クリリン",
  role: "テクニカル",
  icon: "textures/items/gold_nugget",
  cooldownScale: 0.85, // パッシブ: 技のクールタイム 15% 短縮
  base: {
    hp: 900,
    atkAll: 85,
    atkStrike: 15,
    atkEnergy: 20,
    defAll: 45,
    defStrike: 5,
    defEnergy: 10,
    speed: 110,
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
    fist: "gk:krillin_fist",
    skill1: "gk:krillin_skill1",
    skill2: "gk:krillin_skill2",
    skill3: "gk:krillin_skill3",
    ultimate: "gk:krillin_ultimate",
  },
  skills: {
    skill1: {
      name: "気円斬",
      desc: "敵を貫通して切り裂く気の円盤を投げる",
      cooldown: 180,
      cast(p, s, ctx) {
        const dir = p.getViewDirection();
        const dim = p.dimension;
        playSound(dim, "item.trident.throw", p.location, { pitch: 1.4 });
        const side = V.norm({ x: -dir.z, y: 0, z: dir.x });
        launchProjectile(p, {
          origin: V.add(p.getHeadLocation(), V.add(V.scale(dir, 0.8), { x: 0, y: 0.4, z: 0 })),
          dir,
          speed: 1.4,
          range: 26,
          radius: 0.8,
          pierce: true,
          onTick(pos) {
            // 横に広がった円盤
            for (const k of [-0.6, -0.3, 0, 0.3, 0.6]) spawnParticle(dim, "minecraft:endrod", V.add(pos, V.scale(side, k)));
          },
          onHit(target) {
            dealDamage(p, target, { power: 2.2 * ctx.power, type: "energy", knockback: 0.4 });
          },
        });
      },
    },
    skill2: {
      name: "太陽拳",
      desc: "前方10ブロックの敵の目をくらませる。全攻撃力ダウン(25%)・移動速度ダウン(40%)・暗闇 3秒",
      cooldown: 300,
      cast(p, s, ctx) {
        const dim = p.dimension;
        const head = p.getHeadLocation();
        const dir = p.getViewDirection();
        playSound(dim, "random.orb", p.location, { pitch: 2 });
        for (let i = 0; i < 10; i++) {
          spawnParticle(dim, "minecraft:totem_particle", V.add(head, { x: Math.random() - 0.5, y: Math.random() * 0.6, z: Math.random() - 0.5 }));
        }
        const ticks = Math.round(60 * ctx.power);
        for (const e of enemiesNear(p, head, 10)) {
          const to = V.norm(V.sub(center(e), head));
          if (V.dot(to, dir) < 0.3) continue; // 前方のみ
          addModifiers(e, "krillin_taiyoken", { atkAll: -25, speed: -40 }, ticks);
          try {
            e.addEffect("blindness", ticks, { showParticles: false });
          } catch {}
        }
      },
    },
    skill3: {
      name: "仙豆",
      desc: "自分と周囲8ブロックの味方のHPを最大HPの30%回復",
      cooldown: 480,
      cast(p, s, ctx) {
        playSound(p.dimension, "random.burp", p.location);
        for (const a of alliesNear(p, p.location, 8)) {
          heal(a, getStat(a, "hp") * 0.3 * ctx.power);
          for (let i = 0; i < 6; i++) {
            spawnParticle(a.dimension, "minecraft:villager_happy", V.add(a.location, { x: Math.random() - 0.5, y: Math.random() * 2, z: Math.random() - 0.5 }));
          }
        }
      },
    },
    ultimate: {
      name: "拡散エネルギー波",
      desc: "周囲18ブロックの敵(最大5体)に気弾を放ち、全防御力ダウン(20%/5秒)",
      cast(p, s, ctx) {
        const dim = p.dimension;
        const origin = V.add(p.getHeadLocation(), { x: 0, y: 1, z: 0 });
        playSound(dim, "mob.blaze.shoot", p.location, { pitch: 0.8 });
        const targets = enemiesNear(p, p.location, 18)
          .sort((a, b) => V.dist(a.location, p.location) - V.dist(b.location, p.location))
          .slice(0, 5);
        targets.forEach((target, i) => {
          system.runTimeout(() => {
            if (!p.isValid || !target.isValid) return;
            launchProjectile(p, {
              origin,
              dir: V.norm(V.sub(center(target), origin)),
              speed: 1.6,
              range: 24,
              radius: 1.0,
              particle: "minecraft:basic_flame_particle",
              onHit(hit) {
                spawnParticle(dim, "minecraft:large_explosion", center(hit));
                dealDamage(p, hit, { power: 2.5 * ctx.power, type: "energy", knockback: 0.6, lift: 0.2 });
                addModifiers(hit, "krillin_ult_def", { defAll: -20 }, 100);
              },
            });
          }, i * 3);
        });
      },
    },
  },
  passive: {
    name: "地球人の工夫",
    desc: "技のクールタイムが15%短い。移動速度が少し速い",
  },
});
