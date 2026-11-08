import { world, system, EntityDamageCause, EntitySwingSource } from "@minecraft/server";
import "./characters/index.js";
import { getState, removeState, getPlayerCharacter, addGauge, notify } from "./core/state.js";
import { getStat, getModifiers, addModifiers, removeModifier, clearModifiers, getModifiedEntityIds, modifierLabel } from "./core/stats.js";
import { dealDamage, findTarget, playSound, spawnParticle } from "./core/combat.js";
import { skillPower, skillCooldownScale, setLevelUpHandler, addXp } from "./core/progression.js";
import { TEAM_COLOR } from "./core/team.js";
import { hpBar } from "./core/hpbar.js";
import { showTitle, sendHud, resetHud, glyphHpBar, HUD_SELF, HUD_PARTY } from "./core/display.js";
import { cardScale } from "./core/cards.js";
import { V, center } from "./core/vec.js";
import { MENU_ITEM, BURST_ITEM, ensureMenuItem, selectCharacter, statsText } from "./core/selection.js";
import { tickMatch, matchHudLine, onEntityDie, onPlayerSpawn, useBurst, startBattle, resetToLobby, setTeam, toggleReady, teamMembers } from "./game/match.js";
import { setLoc, addNpcPoint, clearNpcPoints, autoSetup, locationsText, LOCATION_NAMES } from "./game/locations.js";
import { openMainMenu, openUpgrade } from "./menu.js";

const SKILL_KEYS = ["skill1", "skill2", "skill3", "ultimate"];
const RUSH_ANIM = "animation.attack";
const RUSH_CONTROLLER = "gk_rush";
const RUSH_ANIM_TICKS = 8; // animation.attack の長さ 0.4167 秒 ≒ 8.3 tick

// ラッシュのエフェクト(リソースパック側で定義)
const RUSH_PARTICLE_EVERY = "anni:rush3"; // 毎ヒット
const RUSH_PARTICLES_SOMETIMES = ["anni:rush1", "anni:rush2"]; // たまにどちらか
const RUSH_PARTICLE_SOMETIMES_CHANCE = 0.3; // 30%
const RUSH_SOUNDS = ["gk.rush1", "gk.rush2"]; // ランダム

// 左クリック長押しの判定: 腕振り(swing)が SWING_GAP tick 以内の間隔で
// HOLD_TICKS tick 以上続いたら「長押し」とみなしてラッシュ開始。途切れたら終了。
const SWING_GAP = 10;
const HOLD_TICKS = 8;
const RUSH_SWING_SOURCES = new Set([EntitySwingSource.Attack, EntitySwingSource.Mine, EntitySwingSource.None]);

function heldItem(player) {
  try {
    return player.getComponent("minecraft:inventory").container.getItem(player.selectedSlotIndex);
  } catch {
    return undefined;
  }
}

// ---------- スキル ----------

function useSkill(player, ch, key) {
  const s = getState(player);
  const now = system.currentTick;
  const skill = ch.skills[key];
  if (s.dead) return;
  // 溜め中は他の技を使えない (界王拳のように usableWhileCasting の技は例外)
  if (now < s.castingUntil && !skill.usableWhileCasting) return;

  if (key === "ultimate") {
    if (s.gauge < 100) return notify(player, `§c必殺技ゲージが足りません (${Math.floor(s.gauge)}%)`);
  } else {
    const remain = (s.cooldowns[key] ?? 0) - now;
    if (remain > 0) return notify(player, `§c${skill.name} はクールダウン中 (${(remain / 20).toFixed(1)}秒)`);
  }

  stopRush(player, s);
  // ctx.power: 技レベルによる威力倍率
  const ctx = { power: skillPower(s, key), level: s.skillLv[key] };
  if (skill.cast(player, s, ctx) === false) return;
  notify(player, `§a${skill.name}!`, 20);

  if (key === "ultimate") {
    s.gauge = 0;
  } else {
    const cd = Math.round(skill.cooldown * (ch.cooldownScale ?? 1) * skillCooldownScale(s, key) * cardScale(s.cards, "cdScale"));
    s.cooldowns[key] = now + cd;
    try {
      player.startItemCooldown(ch.items[key].replace(":", "_"), cd);
    } catch {}
  }
}

// ---------- ラッシュ ----------

// animation.attack を 1 ループ分(既定の stopExpression = 1 周で終了)ずつ再生し、
// ラッシュ中はスクリプト側で RUSH_ANIM_TICKS ごとに再生し直す。
// クライアント側の判定(is_using_item 等)に頼らないので途中で止まらない。
function playRushAnim(player, s) {
  s.rushAnimAt = system.currentTick;
  try {
    player.playAnimation(RUSH_ANIM, { controller: RUSH_CONTROLLER, blendOutTime: 0 });
  } catch {}
}

function startRush(player, s) {
  s.rushing = true;
  s.rushStart = system.currentTick;
  playRushAnim(player, s);
}

// 再生し直さなければ今の 1 周が終わった所で自然に止まる
function stopRush(player, s) {
  s.rushing = false;
}

function rushHit(player, ch, power, knockback, lift) {
  const target = findTarget(player, ch.attack.range);
  if (target) dealDamage(player, target, { power, type: ch.attack.type, knockback, lift });

  // エフェクトは当たった相手の位置、空振りなら目の前に出す
  const pos = target ? center(target) : V.add(player.getHeadLocation(), V.add(V.scale(player.getViewDirection(), 1.5), { x: 0, y: -0.4, z: 0 }));
  const dim = player.dimension;
  spawnParticle(dim, RUSH_PARTICLE_EVERY, pos);
  if (Math.random() < RUSH_PARTICLE_SOMETIMES_CHANCE) spawnParticle(dim, pick(RUSH_PARTICLES_SOMETIMES), pos);
  playSound(dim, pick(RUSH_SOUNDS), pos);
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// 腕を振るたびに呼ばれる。連続していれば長押しとみなす
function onSwing(player, ch, s, now) {
  // 長押しが途切れていた → 新しい押し始め
  if (now - (s.lastSwing ?? -Infinity) > SWING_GAP) s.swingStreakStart = now;
  s.lastSwing = now;
  if (!s.rushing && now >= s.castingUntil && now - s.swingStreakStart >= HOLD_TICKS) {
    startRush(player, s);
  }
}

function tickRush(player, ch, s, now) {
  if (!s.rushing) return;
  // 左クリックを離した(腕振りが途切れた) or 拳以外に持ち替えた
  if (now - s.lastSwing > SWING_GAP || heldItem(player)?.typeId !== ch.items.fist) return stopRush(player, s);
  const a = ch.attack;
  const t = now - s.rushStart;
  if (t >= a.rushTicks) {
    // ラッシュの締め：吹き飛ばし。クールタイム無しで、押し続けていればそのまま次のラッシュへ
    rushHit(player, ch, a.finisherPower, 1.0, 0.35);
    s.rushStart = now + 1;
    return;
  }
  if (now - s.rushAnimAt >= RUSH_ANIM_TICKS) playRushAnim(player, s);
  if (t % a.interval === 0) rushHit(player, ch, a.rushPower, 0, 0);
}

// ---------- HUD ----------

function hud(player, ch, s, now) {
  const health = player.getComponent("minecraft:health");
  const hpMax = getStat(player, "hp");
  const hp = Math.ceil((health.currentValue / health.effectiveMax) * hpMax);
  const gauge = s.gauge >= 100 ? "§6§l必殺技 READY§r" : `§e必殺 ${Math.floor(s.gauge)}%`;
  const cds = ["skill1", "skill2", "skill3"]
    .map((k, i) => {
      const r = (s.cooldowns[k] ?? 0) - now;
      return r > 0 ? `§7[${i + 1}:${Math.ceil(r / 20)}]` : `§a[${i + 1}:OK]`;
    })
    .join(" ");

  // HP は画面下のゲージ (gkhud_s) に出すので、ここは必殺技ゲージとクールタイム
  const lines = [matchHudLine(player, now), `§f${ch.name}  ${gauge}  ${cds}`];

  // 同じラベル(例: 移動速度ダウン)はまとめて残り時間の長い方を表示
  const groups = new Map();
  for (const m of getModifiers(player)) {
    const label = modifierLabel(m);
    const rest = m.until - now;
    if ((groups.get(label)?.rest ?? -1) < rest) groups.set(label, { rest, up: m.pct >= 0 });
  }
  if (groups.size) {
    lines.push([...groups].map(([label, g]) => `${g.up ? "§a" : "§c"}${label} ${Math.ceil(g.rest / 20)}s`).join(" "));
  }
  if (s.notice && s.notice.until > now) lines.push(s.notice.text);
  player.onScreenDisplay.setActionBar(lines.join("\n"));
}

// ---------- HP ゲージ (自分: ホットバーの上 / 味方: 画面左の中央) ----------
// 表示は RP の ui/gk_hud.json。ゲージは sabaibaruRPG-RP のフォントのグリフ

function hpInfo(p) {
  const health = p.getComponent("minecraft:health");
  const max = getStat(p, "hp");
  const ratio = health ? health.currentValue / health.effectiveMax : 0;
  return { ratio, hp: Math.max(0, Math.ceil(ratio * max)), max: Math.round(max) };
}

function sendSelfHud(player, ch, s) {
  const { ratio, hp, max } = hpInfo(player);
  const lv = s.inMatch ? ` §bLv${s.level}` : "";
  sendHud(player, HUD_SELF, `§f${ch.name}${lv}\n§f${glyphHpBar(ratio)} §f${hp}§7/§f${max}`);
}

function sendPartyHud(player, s) {
  const allies = s.team ? teamMembers(s.team).filter((p) => p.id !== player.id) : [];
  if (!allies.length) return sendHud(player, HUD_PARTY, "");
  const lines = ["§l§a味方§r"];
  for (const a of allies) {
    const as = getState(a);
    const ch = getPlayerCharacter(a);
    lines.push(`§f${a.name} §7${ch?.name ?? "未選択"}${as.inMatch ? ` §bLv${as.level}` : ""}`);
    if (as.dead) {
      lines.push(`§c復活まで ${Math.max(0, Math.ceil((as.respawnAt - system.currentTick) / 20))}秒`);
    } else {
      const { ratio, hp, max } = hpInfo(a);
      lines.push(`§f${glyphHpBar(ratio)} §f${hp}`);
    }
  }
  sendHud(player, HUD_PARTY, lines.join("\n"));
}

// ---------- 頭上の HP バー (ネームタグ) ----------

function updateHpTag(player, ch, s) {
  const health = player.getComponent("minecraft:health");
  const hpMax = getStat(player, "hp");
  const ratio = health.currentValue / health.effectiveMax;
  const name = `${TEAM_COLOR[s.team] ?? "§f"}${player.name}${s.inMatch ? ` §bLv${s.level}` : ""}`;
  const tag = `${name}\n${hpBar(ratio)}\n§f${Math.ceil(ratio * hpMax)}/${Math.round(hpMax)}`;
  // 変化した時だけ送る
  if (s.hpTag !== tag) {
    s.hpTag = tag;
    player.nameTag = tag;
  }
}

// ---------- 移動速度 → ポーション効果 ----------
// 移動速度 100 = 通常。スピード1段階 = +20%, 鈍化1段階 = -15%

function applySpeedEffect(e) {
  const pct = getStat(e, "speed") - 100;
  try {
    if (pct >= 10) {
      e.removeEffect("slowness");
      e.addEffect("speed", 15, { amplifier: Math.max(0, Math.round(pct / 20) - 1), showParticles: false });
    } else if (pct <= -10) {
      e.removeEffect("speed");
      e.addEffect("slowness", 15, { amplifier: Math.max(0, Math.round(-pct / 15) - 1), showParticles: false });
    } else {
      e.removeEffect("speed");
      e.removeEffect("slowness");
    }
  } catch {}
}

function applySpeedEffects() {
  const ids = new Set(getModifiedEntityIds());
  for (const p of world.getAllPlayers()) if (getPlayerCharacter(p)) ids.add(p.id);
  for (const id of ids) {
    const e = world.getEntity(id);
    if (e?.isValid) applySpeedEffect(e);
  }
}

// ---------- ダッシュ ----------
// DASH_START_TICKS tick 走り続けるとダッシュ状態: 移動速度アップ + animation.dush1(オーラ ki1 はアニメ側)。止まったら解除

const DASH_START_TICKS = 30; // 1.5 秒
const DASH_SPEED = 40; // 移動速度 +40%
const DASH_ANIM = "animation.dush1"; // ループするアニメ。走るのをやめたらクライアント側で止まる
const DASH_ANIM_STOP = "!query.is_sprinting";

// ダッシュ終了。cancelled = 走ったまま他の行動をした(アニメはクライアント側で止まらないので明示的に止める)
function endDash(player, s, cancelled) {
  s.sprintTicks = 0; // 続けて走っても、また DASH_START_TICKS 走り直すまでダッシュしない
  if (!s.dashing) return;
  s.dashing = false;
  removeModifier(player, "dash");
  applySpeedEffect(player); // すぐ速度を戻す
  if (cancelled) {
    // 同じコントローラーで中身の無い短いアニメを再生して dush1 を上書きして止める
    // (stopExpression "1" で止めると、その後の dush1 まで即終了してしまうため)
    try {
      player.playAnimation("animation.gk.none", { controller: "gk_dash", blendOutTime: 0.2 });
    } catch {}
  }
}

// ダッシュ中に他の行動をしたらキャンセル
function cancelDash(player) {
  if (!getPlayerCharacter(player)) return;
  const s = getState(player);
  if (s.dashing) endDash(player, s, true);
  else s.sprintTicks = 0;
}

function tickDash(player, s, now) {
  const v = player.getVelocity();
  const running = player.isSprinting && Math.hypot(v.x, v.z) > 0.05;
  if (!running) return endDash(player, s, false);
  s.sprintTicks = (s.sprintTicks ?? 0) + 1;
  if (!s.dashing && s.sprintTicks < DASH_START_TICKS) return;

  addModifiers(player, "dash", { speed: DASH_SPEED }, 5);
  if (!s.dashing) {
    s.dashing = true;
    applySpeedEffect(player); // すぐ速度を上げる
    playSound(player.dimension, "mob.phantom.swoop", player.location, { volume: 0.6, pitch: 1.4 });
    try {
      player.playAnimation(DASH_ANIM, { controller: "gk_dash", stopExpression: DASH_ANIM_STOP, blendOutTime: 0.2 });
    } catch {}
  }
}

// ---------- イベント ----------

world.afterEvents.itemUse.subscribe(({ source: player, itemStack }) => {
  if (player.typeId !== "minecraft:player") return;
  cancelDash(player);
  if (itemStack.typeId === MENU_ITEM) {
    // 試合中に強化ポイントがあれば、強化画面 (チェストフォーム) を直接開く
    const s = getState(player);
    return void (s.inMatch && s.points > 0 ? openUpgrade(player) : openMainMenu(player));
  }
  if (itemStack.typeId === BURST_ITEM) return useBurst(player);
  const ch = getPlayerCharacter(player);
  if (!ch) return;
  const key = SKILL_KEYS.find((k) => ch.items[k] === itemStack.typeId);
  if (key) useSkill(player, ch, key);
});

// 左クリック(攻撃/採掘)の腕振り
world.afterEvents.playerSwingStart.subscribe(({ player, swingSource, heldItemStack }) => {
  cancelDash(player); // 攻撃・採掘・設置・使用など、腕を振る行動はすべてダッシュキャンセル
  if (!RUSH_SWING_SOURCES.has(swingSource)) return;
  const ch = getPlayerCharacter(player);
  if (!ch || (heldItemStack ?? heldItem(player))?.typeId !== ch.items.fist) return;
  onSwing(player, ch, getState(player), system.currentTick);
});

world.afterEvents.entityStartSneaking.subscribe(({ entity }) => {
  if (entity.typeId === "minecraft:player") cancelDash(entity);
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  ensureMenuItem(player);
  resetHud(player); // 入り直し・リスポーンで UI 側の HUD 表示が消えることがあるので送り直す
  onPlayerSpawn(player, initialSpawn);
});

// バニラのダメージ (NPC の近接攻撃など) を受けた時刻 (ピッコロのパッシブ用)
world.afterEvents.entityHurt.subscribe(({ hurtEntity }) => {
  if (hurtEntity.typeId === "minecraft:player") getState(hurtEntity).lastHurt = system.currentTick;
});

// レベルアップ演出: 金色のフラッシュ + 光の渦 + ファンファーレ
setLevelUpHandler((player, s) => {
  showTitle(player, `§6§l★ LEVEL UP ★`, `§eLv${s.level - 1} → §6§lLv${s.level}  §r§d強化ポイント ${s.points}`, { fadeIn: 2, stay: 50, fadeOut: 15 });
  try {
    player.camera.fade({ fadeColor: { red: 1, green: 0.85, blue: 0.3 }, fadeTime: { fadeInTime: 0.05, holdTime: 0.05, fadeOutTime: 0.5 } });
  } catch {}
  const dim = player.dimension;
  playSound(dim, "random.levelup", player.location, { pitch: 1.2 });
  playSound(dim, "random.totem", player.location, { volume: 0.5, pitch: 1.4 });
  playSound(dim, "firework.launch", player.location);
  system.runTimeout(() => player.isValid && playSound(dim, "firework.large_blast", player.location), 8);
  system.runTimeout(() => player.isValid && playSound(dim, "firework.twinkle", player.location), 14);
  // 足元から頭上へ巻き上がる光の渦
  let t = 0;
  const handle = system.runInterval(() => {
    if (!player.isValid || ++t > 20) return system.clearRun(handle);
    for (let k = 0; k < 3; k++) {
      const a = t * 0.6 + (k * Math.PI * 2) / 3;
      spawnParticle(dim, "minecraft:totem_particle", V.add(player.location, { x: Math.cos(a) * 1.2, y: t * 0.12, z: Math.sin(a) * 1.2 }));
    }
    if (t === 10) spawnParticle(dim, "minecraft:huge_explosion_emitter", V.add(player.location, { x: 0, y: 3, z: 0 }));
  }, 1);
  notify(player, "§d§lメニュー(本)を使うと技を強化できます！", 60);
});

// 拳で殴った時: マイクラ本来の攻撃(ダメージ・ノックバック)をキャンセルし、
// ステータス計算のダメージに置き換える (ラッシュ中はラッシュ側でダメージを出すのでキャンセルのみ)
world.beforeEvents.entityHurt.subscribe((ev) => {
  const { hurtEntity, damageSource, damage } = ev;
  const attacker = damageSource.damagingEntity;
  if (attacker?.typeId !== "minecraft:player" || damageSource.cause !== EntityDamageCause.entityAttack) return;
  if (damage > 20) return; // dealDamage のとどめ判定は通す
  const ch = getPlayerCharacter(attacker);
  if (!ch || heldItem(attacker)?.typeId !== ch.items.fist) return;
  ev.cancel = true;
  if (getState(attacker).rushing) return;
  // before イベント中はワールドを変更できないので次の処理で
  system.run(() => {
    if (attacker.isValid && hurtEntity.isValid) dealDamage(attacker, hurtEntity, { power: ch.attack.normalPower, type: ch.attack.type });
  });
});

world.afterEvents.entityDie.subscribe(({ deadEntity, damageSource }) => {
  try {
    onEntityDie(deadEntity, damageSource);
  } catch (e) {
    console.warn(`[gk] entityDie: ${e}`);
  }
  clearModifiers(deadEntity.id);
  if (deadEntity.typeId === "minecraft:player") {
    const s = getState(deadEntity);
    s.gauge = 0;
    s.rushing = false;
    s.dashing = false;
    s.sprintTicks = 0;
  }
});

world.afterEvents.entityRemove.subscribe(({ removedEntityId }) => clearModifiers(removedEntityId));

world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  removeState(playerId);
  clearModifiers(playerId);
});

// /scriptevent gk:menu               メニューを開く（メニューアイテムも配布）
// /scriptevent gk:select <goku|piccolo|krillin>  キャラ選択
// /scriptevent gk:team <A|B>         チーム選択 (空なら観戦)
// /scriptevent gk:ready              準備完了の切り替え
// /scriptevent gk:start              強制開始 (テスト)
// /scriptevent gk:end                試合終了してロビーへ
// /scriptevent gk:autosetup          今いる場所=ロビー、向いている方向に全地点を自動配置 (テスト)
// /scriptevent gk:setpos <名前>      今いる場所を地点に設定 (lobby, baseA, baseB, hakaishinA, hakaishinB, dragonballA, dragonballB, boss)
// /scriptevent gk:addnpc             今いる場所を NPC 出現地点に追加 / gk:clearnpc で全消去
// /scriptevent gk:pos                地点一覧
// /scriptevent gk:stats              現在のステータス表示
// /scriptevent gk:gauge              必殺技ゲージを満タン（テスト用）
// /scriptevent gk:xp <量>            経験値を加算（テスト用）
system.afterEvents.scriptEventReceive.subscribe(({ id, message, sourceEntity: player }) => {
  if (player?.typeId !== "minecraft:player") return;
  const arg = message.trim();
  switch (id) {
    case "gk:menu":
      ensureMenuItem(player);
      openMainMenu(player);
      break;
    case "gk:select":
      if (!selectCharacter(player, arg)) player.sendMessage(`§c不明なキャラ: ${arg}`);
      break;
    case "gk:team":
      setTeam(player, arg === "A" || arg === "B" ? arg : undefined);
      break;
    case "gk:ready":
      toggleReady(player);
      break;
    case "gk:start":
      startBattle(true);
      break;
    case "gk:end":
      resetToLobby();
      break;
    case "gk:autosetup":
      autoSetup(player);
      player.sendMessage(`§a地点を自動配置しました\n${locationsText()}`);
      break;
    case "gk:setpos":
      if (!LOCATION_NAMES[arg]) return player.sendMessage(`§c地点名: ${Object.keys(LOCATION_NAMES).join(", ")}`);
      setLoc(arg, player.location);
      player.sendMessage(`§a${LOCATION_NAMES[arg]} を設定しました`);
      break;
    case "gk:addnpc":
      addNpcPoint(player.location);
      player.sendMessage("§aNPC出現地点を追加しました");
      break;
    case "gk:clearnpc":
      clearNpcPoints();
      player.sendMessage("§7NPC出現地点を全て消去しました");
      break;
    case "gk:pos":
      player.sendMessage(locationsText());
      break;
    case "gk:stats":
      player.sendMessage(statsText(player));
      break;
    case "gk:gauge":
      addGauge(player, 100);
      break;
    case "gk:xp":
      addXp(player, Number(arg) || 100);
      break;
  }
});

world.afterEvents.worldLoad.subscribe(() => {
  system.runInterval(() => {
    const now = system.currentTick;
    if (now % 5 === 0) {
      try {
        tickMatch(now);
      } catch (e) {
        console.warn(`[gk] match: ${e}`);
      }
    }
    for (const p of world.getAllPlayers()) {
      try {
        const ch = getPlayerCharacter(p);
        const s = getState(p);
        // HUD 用タイトルは 1 本を共有するので、自分の HP (4 tick ごと) と味方の HP (1 秒ごと・10 tick 目) を別の tick に送る
        if (now % 20 === 10) sendPartyHud(p, s);
        if (!ch) {
          // キャラ未選択でもロビー情報は出す。自分の HP ゲージは消す
          if (now % 4 === 0) {
            p.onScreenDisplay.setActionBar([matchHudLine(p, now), s.notice?.until > now ? s.notice.text : ""].join("\n"));
            sendHud(p, HUD_SELF, "");
          }
          continue;
        }
        if (now % 4 === 0) sendSelfHud(p, ch, s);
        if (s.dead) {
          if (now % 4 === 0) hud(p, ch, s, now);
          continue;
        }
        tickRush(p, ch, s, now);
        tickDash(p, s, now);
        if (now % 4 === 0) {
          hud(p, ch, s, now);
          updateHpTag(p, ch, s);
        }
        if (now % 10 === 0) {
          ch.passive?.tick?.(p, s);
          addGauge(p, 1); // 時間経過で 2%/秒
        }
      } catch (e) {
        console.warn(`[gk] ${e}`);
      }
    }
    if (now % 10 === 0) applySpeedEffects();
  }, 1);
});
