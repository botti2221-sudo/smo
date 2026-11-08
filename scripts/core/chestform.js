import { ActionFormData } from "@minecraft/server-ui";

// チェストフォーム (表示は RP の ui/chest_server_form.json。sabaibaruRPG-RP から移植)
// タイトルの頭の「§c§h§e§s§t§2§7」で UI 側がチェスト表示に切り替わる。アイコンはテクスチャパスで指定する
const SIZES = { 27: "§c§h§e§s§t§2§7§r", 54: "§c§h§e§s§t§5§4§r" };

const pad2 = (n) => String(Math.min(Math.max(n, 0), 99)).padStart(2, "0");

export class ChestForm {
  constructor(size = 27) {
    this.size = SIZES[size] ? size : 27;
    this.titleText = "";
    this.slots = Array(this.size).fill(undefined);
  }

  title(text) {
    this.titleText = text;
    return this;
  }

  // slot: 0 始まり (1 段 9 マス) / lore: 説明の行 / icon: テクスチャパス / run: 押した時の処理
  button(slot, name, lore, icon, run, { stack = 1 } = {}) {
    if (slot >= 0 && slot < this.size) this.slots[slot] = { name, lore: lore ?? [], icon, run, stack };
    return this;
  }

  // 空きマスを埋める (見た目用。押しても何もしない)
  fill(icon = "textures/blocks/glass_gray") {
    for (let i = 0; i < this.size; i++) this.slots[i] ??= { name: " ", lore: [], icon };
    return this;
  }

  async show(player) {
    const form = new ActionFormData().title(SIZES[this.size] + this.titleText);
    for (const b of this.slots) {
      if (!b) {
        form.button("");
        continue;
      }
      const text = `stack#${pad2(b.stack)}dur#00§r${b.name}§r${b.lore.map((l) => `\n${l}`).join("")}`;
      form.button(text, b.icon);
    }
    const res = await form.show(player);
    if (res.canceled || res.selection === undefined) return res;
    await this.slots[res.selection]?.run?.();
    return res;
  }
}
