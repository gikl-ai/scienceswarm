/**
 * Whimsical creature-name generator for the user's personal Telegram
 * bot. The goal is charm, not taxonomic accuracy: these are fictional
 * critters with pleasing syllable shapes. Each brain rolls a fresh
 * creature so every ScienceSwarm install has a slightly different
 * personality poking out of its Telegram DMs.
 *
 * Telegram constraints:
 *   - Display name: unrestricted, up to ~64 chars.
 *   - Username: 5-32 chars, alphanumeric + underscore, must end in
 *     `bot` (case-insensitive). We always end in lowercase `bot`.
 */

export const CREATURE_WORDS: readonly string[] = [
  "wobblefinch",
  "snarflepuff",
  "grumbletoad",
  "fizzletail",
  "wispkit",
  "mossgrub",
  "thistlehorn",
  "drizzlebeak",
  "murkworm",
  "quillfern",
  "cloudsprout",
  "pebblewhisker",
  "tangleburr",
  "nimblepaw",
  "velvetsnout",
  "bramblewing",
  "puddlehop",
  "lichenling",
  "sootferret",
  "glimmerfish",
  "bogmonkey",
  "ribbonmoth",
  "pipercrab",
  "dustwren",
  "marblegoat",
  "shimmertoad",
  "tuftlark",
  "crumblemouse",
  "ferncreeper",
  "sparkhare",
  "mirrorhog",
  "amberfly",
  "plumpbadger",
  "snufflekin",
  "twigshrew",
  "crispvole",
  "bristlemole",
  "warblefox",
  "barkowl",
  "jellyotter",
  "gentlenewt",
  "honeywisp",
  "mistbun",
  "rubyslug",
  "toadstoolcat",
] as const;

export function randomCreature(): string {
  const i = Math.floor(Math.random() * CREATURE_WORDS.length);
  return CREATURE_WORDS[i];
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function creatureDisplayName(creature: string): string {
  const capitalized = capitalize(creature);
  const suffix = " — your ScienceSwarm claw";
  const name = capitalized + suffix;
  return name.length > 64 ? capitalized : name;
}

/**
 * Build a Telegram-legal bot username. Shape: `<creature>_<handle>_<suffix>bot`.
 * We truncate the handle as needed so the whole string fits in 32 chars.
 * `suffix` is optional; the caller passes a 3-4 char token on collision retry.
 */
export function creatureUsername(
  creature: string,
  handle: string,
  suffix: string,
): string {
  const cleanCreature = creature.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanHandle = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, "");

  // When the handle sanitizes to empty (all non-alphanumeric, or
  // `handle` itself is empty), we must not emit `<creature>__bot`
  // with a double underscore — build the parts and filter empties
  // before joining. Telegram usernames allow single underscores but
  // doubles look broken.
  const parts = [cleanCreature];
  // Reserve chars for `_handle` + `_suffix` (conditional) + `bot`.
  // First compute suffix length so we know how much handle budget is left.
  const suffixPart = cleanSuffix.length > 0 ? `_${cleanSuffix}` : "";
  // 32 - creature.length - suffixPart.length - "_bot".length reserves
  // space for the handle slot including its leading underscore.
  const handleBudget = Math.max(
    0,
    32 - cleanCreature.length - suffixPart.length - "_bot".length - 1,
  );
  const truncatedHandle = cleanHandle.slice(0, handleBudget);
  if (truncatedHandle.length > 0) {
    parts.push(truncatedHandle);
  }
  if (cleanSuffix.length > 0) {
    parts.push(cleanSuffix);
  }
  parts.push("bot");
  return parts.join("_").slice(0, 32);
}
