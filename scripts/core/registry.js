// キャラクター定義の登録所
const characters = new Map();

export function registerCharacter(def) {
  characters.set(def.id, def);
}

export function getCharacter(id) {
  return characters.get(id);
}

export function getAllCharacters() {
  return [...characters.values()];
}
