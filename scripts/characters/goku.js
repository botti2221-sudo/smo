import { system } from "@minecraft/server";
import { registerCharacter } from "../core/registry.js";
import { addModifiers, hasModifier } from "../core/stats.js";
import { dealDamage, findTarget, launchProjectile, fireBeam, isPassable, spawnParticle, playSound } from "../core/combat.js";
import { V, center } from "../core/vec.js";

const UP = { x: 0, y: 1, z: 0 };

// 気弾の見た目を大きくする: 中心 + 進行方向に垂直な上下左右に kame3 を追加で出す
function bigOrb(dim, pos, dir, size) {
  spawnParticle(dim, "anni:kame3", pos);
  const side = V.norm({ x: -dir.z, y: 0, z: dir.x });
  const up = V.norm({ x: 0, y: 1, z: 0 });
  for (const off of [side, V.scale(side, -1), up, V.scale(up, -1)]) spawnParticle(dim, "anni:kame3", V.add(pos, V.scale(off, size)));
}

registerCharacter({
  id: "goku",
  name: "孫悟空",
  role: "ダメージ",
  icon: "textures/items/blaze_powder", // キャラ選択画面のアイコン
  base: {
    hp: 1000,
    atkAll: 100,
    atkStrike: 25,
    atkEnergy: 10,
    defAll: 50,
    defStrike: 10,
    defEnergy: 5,
    speed: 100,
  },
  // 通常攻撃 / ラッシュ（近距離・打撃）
  attack: {
    type: "strike",
    range: 3.5,
    normalPower: 0.6, // 単発の殴り
    rushPower: 0.25, // ラッシュ 1 ヒット
    interval: 4, // ラッシュのヒット間隔(tick)
    rushTicks: 60, // ラッシュ最大継続 → フィニッシュ
    finisherPower: 1.2,
  },
  items: {
    fist: "gk:goku_fist",
    skill1: "gk:goku_skill1",
    skill2: "gk:goku_skill2",
    skill3: "gk:goku_skill3",
    ultimate: "gk:goku_ultimate",
  },
  skills: {
    skill1: {
      name: "かめはめ波",
      desc: "1秒溜めて敵を貫通する気弾を放つ。命中で吹き飛ばし、移動速度ダウン(20%/1.5秒)。界王拳中は巨大化",
      cooldown: 160,
      cast(p, s, ctx) {
        const CHARGE = 20; // 溜め 1 秒 (animation.goku1 の 0〜1.0 秒が溜めポーズ)
        s.castingUntil = system.currentTick + CHARGE + 2;
        addModifiers(p, "goku_s1_charge", { speed: -50 }, CHARGE);
        try {
          p.playAnimation("animation.goku1", { controller: "gk_skill", blendOutTime: 0.2 });
        } catch {}
        // goku1 はループアニメなので 1 周(2.25 秒 = 45 tick)で止める
        system.runTimeout(() => {
          try {
            if (p.isValid) p.playAnimation("animation.gk.none", { controller: "gk_skill", blendOutTime: 0.2 });
          } catch {}
        }, 45);
        playSound(p.dimension, "gk.goku1", p.location); // 溜め〜発射までの音

        // 両手の前あたり
        const handPos = () => V.add(p.getHeadLocation(), V.add(V.scale(p.getViewDirection(), 0.8), { x: 0, y: -0.5, z: 0 }));
        let t = 0;
        const handle = system.runInterval(() => {
          if (!p.isValid) return system.clearRun(handle);
          // 溜め: kame1(光) / kame2(集まる線)。エミッターが 0.5 秒持つので 10 tick ごと
          if (t < CHARGE) {
            if (t % 10 === 0) {
              spawnParticle(p.dimension, "anni:kame1", handPos());
              spawnParticle(p.dimension, "anni:kame2", handPos());
            }
            t++;
            return;
          }
          system.clearRun(handle);

          // 発射: kame3(気弾本体) を毎 tick、kame4(火花) を 2 tick ごと、着弾で kame5
          // 発射の瞬間に界王拳中なら巨大かめはめ波 (当たり判定 2 倍・威力 1.5 倍・見た目も大きく)
          const big = hasModifier(p, "goku_kaioken");
          const dir = p.getViewDirection();
          const dim = p.dimension;
          const burst = (pos) => {
            spawnParticle(dim, "anni:kame5", pos);
            spawnParticle(dim, "anni:kame4", pos);
            if (big) spawnParticle(dim, "minecraft:large_explosion", pos);
            playSound(dim, "random.explode", pos, { volume: big ? 0.8 : 0.4, pitch: big ? 1.0 : 1.6 });
          };
          launchProjectile(p, {
            origin: handPos(),
            dir,
            speed: 1.2,
            range: 24,
            radius: big ? 1.8 : 0.9,
            pierce: true, // 敵を貫通して射程いっぱいまで飛ぶ
            onTick(pos, tick) {
              if (big) bigOrb(dim, pos, dir, 0.9);
              else spawnParticle(dim, "anni:kame3", pos);
              if (tick % 2 === 0) spawnParticle(dim, "anni:kame4", pos);
            },
            onEnd: burst,
            onHit(target, pos) {
              burst(pos);
              dealDamage(p, target, { power: 1.8 * ctx.power * (big ? 1.5 : 1), type: "energy", knockback: big ? 1.6 : 1.0, lift: 0.3 });
              addModifiers(target, "goku_s1_slow", { speed: -20 }, 30);
            },
          });
        }, 1);
      },
    },
    skill2: {
      name: "瞬間移動",
      desc: "視線の先の相手の背後へ瞬間移動（相手がいなければ前方8ブロック）。打撃攻撃力アップ(20%/4秒)",
      cooldown: 240,
      cast(p, s, ctx) {
        const dim = p.dimension;
        const standable = (loc) => isPassable(dim, loc) && isPassable(dim, V.add(loc, UP));
        spawnParticle(dim, "minecraft:knockback_roar_particle", center(p));
        playSound(dim, "mob.endermen.portal", p.location);

        const target = findTarget(p, 15, 0.9);
        let dest;
        let face;
        if (target) {
          dest = V.sub(target.location, V.scale(V.flat(target.getViewDirection()), 1.5));
          if (!standable(dest)) dest = V.add(target.location, V.scale(V.flat(V.sub(p.location, target.location)), 1.5));
          face = center(target);
        } else {
          const dir = V.flat(p.getViewDirection());
          let dist = 0;
          for (let d = 0.5; d <= 8; d += 0.5) {
            if (!standable(V.add(p.location, V.scale(dir, d)))) break;
            dist = d;
          }
          dest = V.add(p.location, V.scale(dir, dist));
          face = V.add(dest, V.add(V.scale(dir, 5), { x: 0, y: 1.6, z: 0 }));
        }
        p.teleport(dest, { facingLocation: face });
        spawnParticle(dim, "minecraft:knockback_roar_particle", V.add(dest, { x: 0, y: 0.9, z: 0 }));
        playSound(dim, "mob.endermen.portal", dest);
        addModifiers(p, "goku_it", { atkStrike: 20 * ctx.power }, 80);
      },
    },
    skill3: {
      name: "界王拳",
      desc: "8秒間 全攻撃力アップ(25%)・移動速度アップ(20%)、代わりに全防御力ダウン(10%)。かめはめ波の溜め中にも使え、かめはめ波が巨大化",
      cooldown: 440,
      usableWhileCasting: true, // かめはめ波の溜め中でも使える
      cast(p, s, ctx) {
        addModifiers(p, "goku_kaioken", { atkAll: 25 * ctx.power, speed: 20, defAll: -10 }, 160);
        playSound(p.dimension, "gk.goku3", p.location);
        try {
          // 発動ポーズ。kaio2,3(発動時)はこのアニメの particle_effects から locator2 に出す。
          // goku2 の timeline が variable.gk_kaioken_end をセットし、
          // kaio1,ki2(8 秒間付きっぱなし)はコントローラー controller.animation.gk.kaioken_aura が 1 個だけ出す
          p.playAnimation("animation.goku2", { controller: "gk_kaioken", blendOutTime: 0.1 });
        } catch {}
        // goku2 はループアニメ(1 秒)。ループの頭に戻ると発動時パーティクルがもう一度出るので、少し手前(16 tick)で止める
        system.runTimeout(() => {
          try {
            if (p.isValid) p.playAnimation("animation.gk.none", { controller: "gk_kaioken", blendOutTime: 0.1 });
          } catch {}
        }, 16);
      },
    },
    ultimate: {
      name: "超かめはめ波",
      desc: "1秒溜めて極太のビームを放つ。命中で大きく吹き飛ばし、移動速度ダウン(30%/3秒)",
      cast(p, s, ctx) {
        s.castingUntil = system.currentTick + 25;
        addModifiers(p, "goku_ult_charge", { speed: -70 }, 25);
        playSound(p.dimension, "mob.warden.sonic_charge", p.location);
        let t = 0;
        const handle = system.runInterval(() => {
          if (!p.isValid) return system.clearRun(handle);
          const dir = p.getViewDirection();
          const hand = V.add(p.getHeadLocation(), V.add(V.scale(dir, 0.8), { x: 0, y: -0.4, z: 0 }));
          if (++t < 20) {
            if (t % 2 === 0) spawnParticle(p.dimension, "minecraft:blue_flame_particle", hand);
            return;
          }
          system.clearRun(handle);
          playSound(p.dimension, "mob.warden.sonic_boom", p.location);
          fireBeam(p, {
            origin: hand,
            dir,
            range: 30,
            radius: 1.5,
            particles: ["minecraft:endrod", "minecraft:blue_flame_particle"],
            visualTicks: 12,
            onHit(target) {
              dealDamage(p, target, { power: 5 * ctx.power, type: "energy", knockback: 2.0, lift: 0.5 });
              addModifiers(target, "goku_ult_slow", { speed: -30 }, 60);
            },
          });
        }, 1);
      },
    },
  },
  passive: {
    name: "サイヤ人の底力",
    desc: "HPが30%以下の間、全攻撃力アップ(20%)・全防御力アップ(15%)",
    // 10 tick ごとに呼ばれる
    tick(p) {
      const h = p.getComponent("minecraft:health");
      if (h.currentValue / h.effectiveMax <= 0.3) addModifiers(p, "goku_passive", { atkAll: 20, defAll: 15 }, 15);
    },
  },
});
