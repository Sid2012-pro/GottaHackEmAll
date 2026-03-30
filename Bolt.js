const axios = require('axios');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { App, ExpressReceiver } = require('@slack/bolt');

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
});

// == constants ==
const DATA_FILE = path.join(__dirname, 'userdata.json');
const activeBattles = new Map();
// the channel where im spawning wild pokemon every hour or so - MAKE SURE TO JOIN hackemon on hack club workspace!
const WILD_SPAWN_CHANNEL = 'C0APN5D2HGC';
const WILD_SPAWN_INTERVAL = 60 * 60 * 1000; // secs*minutes*nanosecs
const TRAINER_LEVEL_EXP = [0, 0, 200, 450, 800, 1250, 1800, 2500, 3300, 4200, 5500];
// above (^) these are the level exp requirements, ignore the two zeroes, since im using index to access these
// i have to put lv.0 and lv.1 as 0,0 i could also just add 1 to the level and start from zero, but this is simpler
const MAX_TRAINER_LEVEL = 10;
const POKEMON_LEVEL_XP_COST = [0, 0, 30, 50, 80, 120, 170, 230, 300, 380, 500];
const MAX_POKEMON_LEVEL = 10;
const STAT_BOOST_PER_LEVEL = 0.08; // 8% per level
const LEVEL_MOVES = {
  2: 'quick strike', 3: 'power up', 4: 'endure', 5: 'focus beam',
  6: 'shell armor', 7: 'hyper strike', 8: 'last resort', 9: 'mega drain', 10: 'ultimate move',
};
const pendingChallenges = new Map();
const wildSpawns = new Map(); // ts -> { pokemon, channelId, expiresAt, caught }
app.use(async ({ ack, next }) => {
  try {
    await ack();
  } catch (e) {
  }
  await next();
});
function loadUserData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Error loading user data:', e); }
  return {};
}

function saveUserData(data) {
  try {
    const merged = { ...loadUserData(), ...data };
    fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2));
  } catch (e) { console.error('Error saving user data:', e); }
}

function getUserData(userId) {
  const data = loadUserData();
  if (!data[userId]) {
    data[userId] = {
      hacktimeUsername: null, minutesUsedForCatching: 0,
      pokemonTeam: [], pokedex: [], totalCaught: 0,
      level: 1, xp: 0, cachedHackatimeMinutes: 0,
      lastHackatimeSync: 0, battleRecord: { wins: 0, losses: 0 },
      primaryLanguage: null, dailyQuest: null,
    };
    saveUserData({ [userId]: data[userId] });
  }
  const u = data[userId];
  if (!u.battleRecord) u.battleRecord = { wins: 0, losses: 0 };
  if (!u.dailyQuest) u.dailyQuest = null;

  // FIX: Migrate pokemon to have level fields and persist the migration
  if (u.pokemonTeam) {
    const migrated = u.pokemonTeam.map(p => ({
      pokemonLevel: 1, pokemonXp: 0, moves: ['tackle'], ...p,
    }));
    // Only save if something actually changed
    const changed = JSON.stringify(migrated) !== JSON.stringify(u.pokemonTeam);
    u.pokemonTeam = migrated;
    if (changed) saveUserData({ [userId]: u });
  }
  return u;
}

function getAllUserData() { return loadUserData(); }

// == trainer levelling ==

function addTrainerXp(userData, amount) {
  userData.xp = (userData.xp || 0) + amount;
  const oldLevel = userData.level || 1;
  let newLevel = oldLevel;
  while (newLevel < MAX_TRAINER_LEVEL && userData.xp >= (TRAINER_LEVEL_EXP[newLevel + 1] || Infinity)) {
    newLevel++;
  }
  userData.level = newLevel;
  return { leveled: newLevel > oldLevel, newLevel, oldLevel };
}

function xpToNextTrainerLevel(userData) {
  const lvl = userData.level || 1;
  if (lvl >= MAX_TRAINER_LEVEL) return null;
  return TRAINER_LEVEL_EXP[lvl + 1] - userData.xp;
}

// == pokemon levelling ==

function getBoostedStats(pokemon) {
  const boost = 1 + ((pokemon.pokemonLevel || 1) - 1) * STAT_BOOST_PER_LEVEL;
  return {
    hp:      Math.floor(pokemon.stats.hp      * boost),
    attack:  Math.floor(pokemon.stats.attack  * boost),
    defense: Math.floor(pokemon.stats.defense * boost),
    sp_atk:  Math.floor(pokemon.stats.sp_atk  * boost),
    sp_def:  Math.floor(pokemon.stats.sp_def  * boost),
    speed:   Math.floor(pokemon.stats.speed   * boost),
  };
}

function levelUpPokemon(userData, teamIndex) {
  const pokemon = userData.pokemonTeam[teamIndex];
  if (!pokemon) return { success: false, reason: 'Pokémon not found.' };
  const lvl = pokemon.pokemonLevel || 1;
  if (lvl >= MAX_POKEMON_LEVEL) return { success: false, reason: `*${pokemon.name}* is already max level (${MAX_POKEMON_LEVEL})!` };
  const cost = POKEMON_LEVEL_XP_COST[lvl + 1] || 999;
  if ((userData.xp || 0) < cost) return { success: false, reason: `Need *${cost} XP* to level up *${pokemon.name}* (you have *${userData.xp} XP*).` };
  userData.xp -= cost;
  pokemon.pokemonLevel = lvl + 1;
  const newMove = LEVEL_MOVES[pokemon.pokemonLevel] || null;
  if (newMove && !pokemon.moves.includes(newMove)) pokemon.moves.push(newMove);
  userData.pokemonTeam[teamIndex] = pokemon;
  return { success: true, newMove, newPokemonLevel: pokemon.pokemonLevel, cost };
}

// == type maps, also language bias ==

const LANGUAGE_TYPE_BIAS = {
  python: ['poison','psychic','grass'], javascript: ['electric','normal','fairy'],
  typescript: ['electric','steel','psychic'], rust: ['steel','rock','ground'],
  go: ['fighting','normal','water'], java: ['fire','fighting','steel'],
  kotlin: ['fire','dragon','steel'], cpp: ['steel','ground','rock'],
  c: ['normal','ground','rock'], ruby: ['fairy','psychic','normal'],
  swift: ['ice','fairy','flying'], php: ['bug','poison','normal'],
  html: ['normal','fairy','flying'], css: ['fairy','water','ice'],
  shell: ['dark','ghost','normal'], bash: ['dark','ghost','normal'],
  haskell: ['psychic','ghost','dragon'], elixir: ['fire','psychic','fairy'],
  lua: ['ghost','psychic','dark'], zig: ['steel','dragon','psychic'],
};

const TYPE_CHART = {
  fire:     { grass:2,ice:2,bug:2,steel:2, water:0.5,fire:0.5,rock:0.5,dragon:0.5 },
  water:    { fire:2,ground:2,rock:2, water:0.5,grass:0.5,dragon:0.5 },
  grass:    { water:2,ground:2,rock:2, fire:0.5,grass:0.5,poison:0.5,flying:0.5,bug:0.5,dragon:0.5,steel:0.5 },
  electric: { water:2,flying:2, electric:0.5,grass:0.5,dragon:0.5,ground:0 },
  ice:      { grass:2,ground:2,flying:2,dragon:2, fire:0.5,water:0.5,ice:0.5,steel:0.5 },
  fighting: { normal:2,ice:2,rock:2,dark:2,steel:2, poison:0.5,bug:0.5,psychic:0.5,flying:0.5,fairy:0.5,ghost:0 },
  poison:   { grass:2,fairy:2, poison:0.5,ground:0.5,rock:0.5,ghost:0.5,steel:0 },
  ground:   { fire:2,electric:2,poison:2,rock:2,steel:2, grass:0.5,bug:0.5,flying:0 },
  flying:   { grass:2,fighting:2,bug:2, electric:0.5,rock:0.5,steel:0.5 },
  psychic:  { fighting:2,poison:2, psychic:0.5,dark:0,steel:0.5 },
  bug:      { grass:2,psychic:2,dark:2, fire:0.5,fighting:0.5,poison:0.5,flying:0.5,ghost:0.5,steel:0.5,fairy:0.5 },
  rock:     { fire:2,ice:2,flying:2,bug:2, fighting:0.5,ground:0.5,steel:0.5 },
  ghost:    { psychic:2,ghost:2, normal:0,dark:0.5 },
  dragon:   { dragon:2, steel:0.5,fairy:0 },
  dark:     { psychic:2,ghost:2, fighting:0.5,dark:0.5,fairy:0.5 },
  steel:    { ice:2,rock:2,fairy:2, fire:0.5,water:0.5,electric:0.5,steel:0.5 },
  fairy:    { fighting:2,dragon:2,dark:2, fire:0.5,poison:0.5,steel:0.5 },
  normal:   { rock:0.5,steel:0.5,ghost:0 },
};

const POKEMON_BY_TYPE = {
  fire:[4,5,6,37,38,58,59,77,78,136,146], water:[7,8,9,54,55,60,61,62,72,73,79,80,86,87,90,91,98,99,116,117,118,119,120,121,129,130,131,134,138,139,140,141],
  grass:[1,2,3,43,44,45,46,47,69,70,71,102,103,114], electric:[25,26,81,82,100,101,125,135,145],
  ice:[87,91,124,131,144], fighting:[56,57,62,66,67,68,106,107],
  poison:[1,2,3,13,14,15,23,24,29,30,31,32,33,34,41,42,43,44,45,48,49,88,89,109,110],
  ground:[27,28,50,51,74,75,76,95,104,105,111,112], flying:[16,17,18,21,22,41,42,83,84,85,123,142,144,145,146,149],
  psychic:[63,64,65,79,80,96,97,102,103,121,122,124,137,150,151], bug:[10,11,12,13,14,15,46,47,48,49,123,127,142],
  rock:[74,75,76,95,111,112,138,139,140,141,142], ghost:[92,93,94], dragon:[147,148,149],
  normal:[16,17,18,19,20,35,36,39,40,52,53,83,84,85,108,113,115,128,132,133,137],
  steel:[], dark:[], fairy:[35,36,39,40],
};

const TYPE_EMOJIS = {
  fire:'🔥',water:'💧',grass:'🌿',electric:'⚡',ice:'❄️',fighting:'🥊',poison:'☠️',
  ground:'🌍',flying:'🌬️',psychic:'🔮',bug:'🐛',rock:'🪨',ghost:'👻',dragon:'🐉',
  dark:'🌑',steel:'⚙️',fairy:'✨',normal:'⬜',
};

// == pokemon functions ==

async function fetchPokemonData(id) {
  const r = await axios.get(`https://pokeapi.co/api/v2/pokemon/${id}`);
  const p = r.data;
  return {
    id: p.id, name: p.name.toUpperCase(), imageUrl: p.sprites.front_default,
    stats: { hp: p.stats[0].base_stat, attack: p.stats[1].base_stat, defense: p.stats[2].base_stat, sp_atk: p.stats[3].base_stat, sp_def: p.stats[4].base_stat, speed: p.stats[5].base_stat },
    types: p.types.map(t => t.type.name),
    pokemonLevel: 1, pokemonXp: 0, moves: ['tackle'],
  };
}

async function getRandomPokemon(primaryLanguage = null) {
  try {
    const lang = primaryLanguage ? primaryLanguage.toLowerCase() : null;
    const biasedTypes = lang && LANGUAGE_TYPE_BIAS[lang] ? LANGUAGE_TYPE_BIAS[lang] : null;
    let id;
    if (biasedTypes && Math.random() < 0.5) {
      const type = biasedTypes[Math.floor(Math.random() * biasedTypes.length)];
      const pool = POKEMON_BY_TYPE[type];
      id = pool && pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : Math.floor(Math.random() * 151) + 1;
    } else {
      id = Math.floor(Math.random() * 151) + 1;
    }
    return await fetchPokemonData(id);
  } catch (e) { console.error('Error fetching Pokemon:', e); return null; }
}

function createPokemonBlock(pokemon, showLevel = true) {
  const typeDisplay = pokemon.types.map(t => `${TYPE_EMOJIS[t]||''}${t}`).join(' / ');
  const b = getBoostedStats(pokemon);
  const lvl = pokemon.pokemonLevel || 1;
  const levelLine = showLevel ? `\n⭐ Lv.${lvl}/10 | Moves: ${(pokemon.moves||['tackle']).join(', ')}` : '';
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${pokemon.name}*\nType: ${typeDisplay}${levelLine}\n❤️ ${b.hp} | ⚔️ ${b.attack} | 🛡️ ${b.defense} | 🌀 ${b.sp_atk} | 💫 ${b.sp_def} | 💨 ${b.speed}` },
    accessory: { type: 'image', image_url: pokemon.imageUrl, alt_text: pokemon.name },
  };
}

// == hackatime ==

async function getHackatimeUserStats(username, userData) {
  try {
    const r = await axios.get(`https://hackatime.hackclub.com/api/v1/users/${username}/stats`, { timeout: 3000 });
    const totalMinutes = Math.floor((r.data.data.total_seconds || 0) / 60);
    const languages = r.data.data.languages || [];
    const primaryLanguage = languages.length > 0 ? languages[0].name : null;
    if (userData) { userData.cachedHackatimeMinutes = totalMinutes; userData.lastHackatimeSync = Date.now(); userData.primaryLanguage = primaryLanguage; }
    return { username: r.data.data.username || username, totalSeconds: r.data.data.total_seconds || 0, totalMinutes, primaryLanguage };
  } catch (e) {
    console.error(`Hackatime API error for "${username}":`, e.message);
    if (userData && userData.cachedHackatimeMinutes) {
      return { username, totalSeconds: userData.cachedHackatimeMinutes * 60, totalMinutes: userData.cachedHackatimeMinutes, primaryLanguage: userData.primaryLanguage || null, cached: true };
    }
    return null;
  }
}

// == battle ==

const TYPE_MOVE_NAMES = {
  fire:['Flamethrower','Ember','Fire Blast','Heat Wave'], water:['Surf','Water Gun','Hydro Pump','Bubble Beam'],
  grass:['Razor Leaf','Solar Beam','Vine Whip','Petal Dance'], electric:['Thunderbolt','Thunder Shock','Thunder','Spark'],
  ice:['Ice Beam','Blizzard','Aurora Beam','Powder Snow'], fighting:['Karate Chop','Low Kick','Submission','Cross Chop'],
  poison:['Poison Sting','Sludge Bomb','Acid','Toxic'], ground:['Earthquake','Dig','Mud Shot','Sand Attack'],
  flying:['Wing Attack','Gust','Aerial Ace','Sky Attack'], psychic:['Psybeam','Psychic','Confusion','Future Sight'],
  bug:['Bug Bite','Signal Beam','Pin Missile','Fury Cutter'], rock:['Rock Throw','Rock Slide','Stone Edge','Rock Blast'],
  ghost:['Shadow Ball','Lick','Night Shade','Hex'], dragon:['Dragon Rage','Dragon Breath','Outrage','Dragon Pulse'],
  dark:['Bite','Crunch','Night Slash','Dark Pulse'], steel:['Iron Tail','Metal Claw','Flash Cannon','Steel Wing'],
  fairy:['Moonblast','Dazzling Gleam','Draining Kiss','Charm'], normal:['Tackle','Body Slam','Quick Attack','Hyper Beam'],
};

function getMoveName(p) { const pool = TYPE_MOVE_NAMES[p.types[0]] || TYPE_MOVE_NAMES.normal; return pool[Math.floor(Math.random() * pool.length)]; }

function calcTypeEff(atkTypes, defTypes) {
  let m = 1;
  for (const a of atkTypes) { const chart = TYPE_CHART[a] || {}; for (const d of defTypes) m *= chart[d] !== undefined ? chart[d] : 1; }
  return m;
}

function calcDmg(attacker, defender) {
  const ab = getBoostedStats(attacker), db = getBoostedStats(defender);
  const base = Math.floor((ab.attack / db.defense) * 20);
  const eff = calcTypeEff(attacker.types, defender.types);
  return { damage: Math.max(1, Math.floor(base * eff * (0.85 + Math.random() * 0.15))), effectiveness: eff };
}

function effText(m) {
  if (m >= 4) return "Super effective!! 🔥🔥"; if (m >= 2) return "Super effective! 🔥";
  if (m === 0) return "No effect 😶"; if (m <= 0.25) return "Not very effective... 🐢🐢";
  if (m < 1) return "Not very effective... 🐢"; return "";
}

function simulateBattle(p1, p2) {
  const s1 = { ...p1, currentHp: getBoostedStats(p1).hp };
  const s2 = { ...p2, currentHp: getBoostedStats(p2).hp };
  const log = [];
  const spd1 = getBoostedStats(p1).speed, spd2 = getBoostedStats(p2).speed;
  const p1First = spd1 !== spd2 ? spd1 > spd2 : Math.random() < 0.5;
  const [first, second] = p1First ? [s1,s2] : [s2,s1];
  log.push(`⚡ *${first.name}* (Lv.${first.pokemonLevel||1}, ${getBoostedStats(first).speed} SPD) moves first!`);
  for (let round = 1; round <= 20 && s1.currentHp > 0 && s2.currentHp > 0; round++) {
    log.push(`\n*— Round ${round} —*`);
    const m1 = getMoveName(first); const { damage: d1, effectiveness: e1 } = calcDmg(first, second);
    second.currentHp = Math.max(0, second.currentHp - d1);
    log.push(`🗡️ *${first.name}* used *${m1}*! Dealt *${d1}* dmg. ${effText(e1)}`);
    log.push(`   ${second.name} HP: ${second.currentHp}/${getBoostedStats(second).hp}`);
    if (second.currentHp <= 0) break;
    const m2 = getMoveName(second); const { damage: d2, effectiveness: e2 } = calcDmg(second, first);
    first.currentHp = Math.max(0, first.currentHp - d2);
    log.push(`🗡️ *${second.name}* used *${m2}*! Dealt *${d2}* dmg. ${effText(e2)}`);
    log.push(`   ${first.name} HP: ${first.currentHp}/${getBoostedStats(first).hp}`);
  }
  let winner, loser;
  if (s1.currentHp > s2.currentHp) { winner = s1; loser = s2; }
  else if (s2.currentHp > s1.currentHp) { winner = s2; loser = s1; }
  else {
    const t1 = Object.values(getBoostedStats(p1)).reduce((a,b)=>a+b,0);
    const t2 = Object.values(getBoostedStats(p2)).reduce((a,b)=>a+b,0);
    winner = t1 >= t2 ? s1 : s2; loser = winner === s1 ? s2 : s1;
    log.push(`\n⚖️ *Tie broken by total stats!*`);
  }
  log.push(`\n💀 *${loser.name}* fainted!\n🏆 *${winner.name}* wins!`);
  return { winner: winner === s1 ? p1 : p2, loser: loser === s1 ? p1 : p2, winnerIsP1: winner === s1, log };
}

// == ui ==

function buildChallengeBlocks(challengerId, challengerPokemon, challengedId, battleKey) {
  const typeDisplay = challengerPokemon.types.map(t=>`${TYPE_EMOJIS[t]||''}${t}`).join(' / ');
  const b = getBoostedStats(challengerPokemon);
  const total = Object.values(b).reduce((a,c)=>a+c,0);
  return [
    { type:'header', text:{ type:'plain_text', text:'⚔️ Pokémon Battle Challenge!', emoji:true } },
    { type:'section', text:{ type:'mrkdwn', text:`<@${challengerId}> is challenging <@${challengedId}> to a battle! 🎮\n\nSending out *${challengerPokemon.name}* (Lv.${challengerPokemon.pokemonLevel||1})!` } },
    { type:'section', text:{ type:'mrkdwn', text:`*${challengerPokemon.name}* — ${typeDisplay}\n❤️ ${b.hp} | ⚔️ ${b.attack} | 🛡️ ${b.defense} | 💨 ${b.speed}\n📊 Total: ${total} | Moves: ${(challengerPokemon.moves||['tackle']).join(', ')}` }, accessory:{ type:'image', image_url:challengerPokemon.imageUrl, alt_text:challengerPokemon.name } },
    { type:'divider' },
    { type:'section', text:{ type:'mrkdwn', text:`<@${challengedId}>, do you accept? Your strongest Pokémon will fight automatically.\n_⏳ Expires in 5 minutes._` } },
    { type:'actions', elements:[
      { type:'button', text:{ type:'plain_text', text:'✅ Accept Battle', emoji:true }, style:'primary', action_id:'accept_battle', value:battleKey },
      { type:'button', text:{ type:'plain_text', text:'❌ Decline', emoji:true }, style:'danger', action_id:'decline_battle', value:battleKey },
    ]},
  ];
}

function buildBattleResultBlocks(cId, dId, cPoke, dPoke, result) {
  const winnerId = result.winnerIsP1 ? cId : dId;
  const loserId  = result.winnerIsP1 ? dId : cId;
  const cb = getBoostedStats(cPoke), db = getBoostedStats(dPoke);
  return [
    { type:'header', text:{ type:'plain_text', text:'⚔️ Battle Results!', emoji:true } },
    { type:'section', fields:[
      { type:'mrkdwn', text:`*<@${cId}>'s ${cPoke.name}* (Lv.${cPoke.pokemonLevel||1})\n📊 ${Object.values(cb).reduce((a,b)=>a+b,0)}` },
      { type:'mrkdwn', text:`*<@${dId}>'s ${dPoke.name}* (Lv.${dPoke.pokemonLevel||1})\n📊 ${Object.values(db).reduce((a,b)=>a+b,0)}` },
    ]},
    { type:'section', fields:[
      { type:'mrkdwn', text:`❤️ ${cb.hp} | ⚔️ ${cb.attack} | 🛡️ ${cb.defense} | 💨 ${cb.speed}` },
      { type:'mrkdwn', text:`❤️ ${db.hp} | ⚔️ ${db.attack} | 🛡️ ${db.defense} | 💨 ${db.speed}` },
    ]},
    { type:'divider' },
    { type:'section', text:{ type:'mrkdwn', text:`*📜 Battle Log*\n${result.log.slice(0,20).join('\n')}` } },
    { type:'divider' },
    { type:'section', text:{ type:'mrkdwn', text:`🏆 *<@${winnerId}> wins!* +100 XP\n😔 <@${loserId}> fought bravely. +25 XP` } },
    { type:'context', elements:[{ type:'mrkdwn', text:'Use `/levelup` to power up your Pokémon for the next battle!' }] },
  ];
}

// == quests ==
const QUEST_TEMPLATES = [
  { id:'code_30', description:'Code for at least 30 minutes today', xpReward:75,  minuteGoal:30 },
  { id:'code_60', description:'Code for at least 60 minutes today', xpReward:150, minuteGoal:60 },
  { id:'code_90', description:'Code for at least 90 minutes today', xpReward:250, minuteGoal:90 },
  { id:'catch_1', description:'Catch 1 Pokémon today',              xpReward:50,  catchGoal:1  },
  { id:'catch_3', description:'Catch 3 Pokémon today',              xpReward:120, catchGoal:3  },
  { id:'battle',  description:'Win a battle today',                 xpReward:100, battleGoal:1 },
];

function generateDailyQuest(userData) {
  const lvl = userData.level || 1;
  let pool = lvl <= 2 ? QUEST_TEMPLATES.filter(q=>q.xpReward<=100)
           : lvl <= 5 ? QUEST_TEMPLATES.filter(q=>q.xpReward<=200)
           : QUEST_TEMPLATES;
  const t = pool[Math.floor(Math.random() * pool.length)];
  return {
    ...t,
    dateKey: new Date().toISOString().slice(0,10),
    completed: false, progress: 0,
    startMinutes: userData.cachedHackatimeMinutes || 0,
    startCaught: userData.totalCaught || 0,
    startWins: (userData.battleRecord||{}).wins || 0,
  };
}

async function sendDailyQuests(client) {
  const allUsers = getAllUserData();
  const todayKey = new Date().toISOString().slice(0,10);
  for (const [userId, userData] of Object.entries(allUsers)) {
    if (!userData.hacktimeUsername) continue;
    if (userData.dailyQuest && userData.dailyQuest.dateKey === todayKey) continue;
    const quest = generateDailyQuest(userData);
    userData.dailyQuest = quest;
    saveUserData({ [userId]: userData });
    try {
      await client.chat.postMessage({
        channel: userId,
        blocks: [
          { type:'header', text:{ type:'plain_text', text:'🌅 Daily Quest!', emoji:true } },
          { type:'section', text:{ type:'mrkdwn', text:`Good morning, Trainer! Here's your quest:\n\n*📋 ${quest.description}*\n\n🎁 Reward: *${quest.xpReward} XP*\n\nUse \`/questclaim\` when done!` } },
          { type:'context', elements:[{ type:'mrkdwn', text:'Check progress anytime with `/queststatus`' }] },
        ],
      });
    } catch(e) { console.error(`Failed to DM quest to ${userId}:`, e.message); }
  }
}

// == spawning wild pokemon ==

async function spawnWildPokemon(client) {
  try {
    const pokemon = await getRandomPokemon();
    if (!pokemon) return;
    const typeDisplay = pokemon.types.map(t=>`${TYPE_EMOJIS[t]||''}${t}`).join(' / ');
    const result = await client.chat.postMessage({
      channel: WILD_SPAWN_CHANNEL,
      blocks: [
        { type:'header', text:{ type:'plain_text', text:'🌿 A wild Pokémon appeared!', emoji:true } },
        { type:'section', text:{ type:'mrkdwn', text:`*A wild ${pokemon.name} appeared!*\nType: ${typeDisplay}\n❤️ ${pokemon.stats.hp} | ⚔️ ${pokemon.stats.attack} | 🛡️ ${pokemon.stats.defense}\n\n*React with 🎯 to catch it!* First trainer to react wins!\n_⏳ Disappears in 30 minutes_` }, accessory:{ type:'image', image_url:pokemon.imageUrl, alt_text:pokemon.name } },
        { type:'context', elements:[{ type:'mrkdwn', text:'You need a linked Hackatime account and at least 1 available minute.' }] },
      ],
    });
    wildSpawns.set(result.ts, { pokemon, channelId: WILD_SPAWN_CHANNEL, expiresAt: Date.now() + 30*60*1000, caught: false });
    setTimeout(async () => {
      const spawn = wildSpawns.get(result.ts);
      if (spawn && !spawn.caught) {
        wildSpawns.delete(result.ts);
        try { await client.chat.update({ channel: WILD_SPAWN_CHANNEL, ts: result.ts, blocks:[{ type:'section', text:{ type:'mrkdwn', text:`🌿 *${pokemon.name}* fled... Nobody caught it in time! 😔` } }] }); } catch(e){}
      }
    }, 30*60*1000);
  } catch(e) { console.error('Error spawning wild Pokemon:', e); }
}

// == reaction handler ==

app.event('reaction_added', async ({ event, client }) => {
  try {
    if (event.reaction !== 'dart') return; // 🎯
    const spawn = wildSpawns.get(event.item.ts);
    if (!spawn || spawn.caught || Date.now() > spawn.expiresAt) { wildSpawns.delete(event.item.ts); return; }

    const userId = event.user;
    const userData = getUserData(userId);
    if (!userData.hacktimeUsername) {
      await client.chat.postMessage({ channel: userId, text: '❌ Link your Hackatime account first with `/linkhackatime <username>`!' }); return;
    }
    const stats = await getHackatimeUserStats(userData.hacktimeUsername, userData);
    const available = stats ? stats.totalMinutes - userData.minutesUsedForCatching : 0;
    if (available < 1) {
      await client.chat.postMessage({ channel: userId, text: '❌ Not enough hacking time to catch this Pokémon! Keep coding.' }); return;
    }

    spawn.caught = true;
    wildSpawns.delete(event.item.ts);
    userData.minutesUsedForCatching += 1;
    const alreadyCaught = userData.pokedex.includes(spawn.pokemon.id);
    if (!alreadyCaught) { userData.pokedex.push(spawn.pokemon.id); userData.totalCaught++; }
    userData.pokemonTeam.push({ ...spawn.pokemon });
    const { leveled, newLevel } = addTrainerXp(userData, 60);
    saveUserData({ [userId]: userData });

    await client.chat.update({ channel: spawn.channelId, ts: event.item.ts, blocks:[
      { type:'section', text:{ type:'mrkdwn', text:`🎉 *<@${userId}> caught the wild ${spawn.pokemon.name}!* ${alreadyCaught?'(duplicate)':'✨ New entry!'}\n+60 XP${leveled?` | 🎊 Trainer Level Up → Lv.${newLevel}!`:''}` }, accessory:{ type:'image', image_url:spawn.pokemon.imageUrl, alt_text:spawn.pokemon.name } },
    ]});
    await client.chat.postMessage({ channel: userId, text: `✅ You caught *${spawn.pokemon.name}* from the wild! +60 XP${leveled?` | 🎊 Level Up → Trainer Lv.${newLevel}!`:''}` });
  } catch(e) { console.error('Error handling wild catch reaction:', e); }
});

// == slash commands ==

app.command('/catch', async ({ ack, body, client }) => {
  try {
    await ack();
    const userId = body.user_id;
    const userData = getUserData(userId);
    const costMinutes = body.text.trim() && parseInt(body.text.trim(),10) > 1 ? 3 : 1;

    if (!userData.hacktimeUsername) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Link Hackatime first! `/linkhackatime <username>`' }); return; }
    const stats = await getHackatimeUserStats(userData.hacktimeUsername, userData);
    if (!stats) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Hackatime unavailable and no cache.' }); return; }
    const available = stats.totalMinutes - userData.minutesUsedForCatching;
    if (available < costMinutes) { await client.chat.postMessage({ channel:body.channel_id, text:`⏰ Need ${costMinutes} min, have ${available}/${stats.totalMinutes}` }); return; }

    const lang = stats.primaryLanguage || userData.primaryLanguage || null;
    const pokemon = await getRandomPokemon(lang);
    if (!pokemon) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Failed to encounter Pokémon. Try again!' }); return; }

    const caught = Math.random() < (costMinutes >= 3 ? 1.0 : 0.7);
    userData.minutesUsedForCatching += costMinutes;
    const alreadyCaught = userData.pokedex.includes(pokemon.id);
    const langNote = lang ? `\n🖥️ Your *${lang}* bias influenced this encounter!` : '';

    if (caught) {
      if (!alreadyCaught) { userData.pokedex.push(pokemon.id); userData.totalCaught++; }
      userData.pokemonTeam.push(pokemon);
      const { leveled, newLevel } = addTrainerXp(userData, 50);
      saveUserData({ [userId]: userData });
      await client.chat.postMessage({ channel:body.channel_id, blocks:[
        { type:'section', text:{ type:'mrkdwn', text:`🎉 *Caught ${pokemon.name}!* (${alreadyCaught?'duplicate':'new ✨'})\n+50 XP${leveled?` | 🎊 Trainer Level Up → Lv.${newLevel}!`:''}${langNote}` } },
        createPokemonBlock(pokemon),
        { type:'context', elements:[{ type:'mrkdwn', text:`Remaining: ${available-costMinutes}/${stats.totalMinutes} min | \`/levelup\` to power up!` }] },
      ]});
    } else {
      saveUserData({ [userId]: userData });
      await client.chat.postMessage({ channel:body.channel_id, blocks:[
        { type:'section', text:{ type:'mrkdwn', text:`😢 *${pokemon.name}* broke free! Cost: ${costMinutes} min${langNote}` } },
        createPokemonBlock(pokemon),
        { type:'context', elements:[{ type:'mrkdwn', text:`Remaining: ${available-costMinutes}/${stats.totalMinutes} min | 💡 Use \`/catch 2\` for guaranteed catch!` }] },
      ]});
    }
  } catch(e) { console.error('Error in /catch:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/linkhackatime', async ({ ack, body, client }) => {
  try {
    await ack();
    const args = body.text.trim();
    if (!args) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Usage: `/linkhackatime <username>`' }); return; }
    const stats = await getHackatimeUserStats(args, null);
    if (!stats) { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Could not find Hackatime user "${args}".` }); return; }
    const allUsers = getAllUserData();
    for (const [uid, d] of Object.entries(allUsers)) {
      if (uid !== body.user_id && d.hacktimeUsername === args) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Username already linked to another player!' }); return; }
    }
    const userData = getUserData(body.user_id);
    Object.assign(userData, { hacktimeUsername: args, minutesUsedForCatching: 0, cachedHackatimeMinutes: stats.totalMinutes, lastHackatimeSync: Date.now(), primaryLanguage: stats.primaryLanguage });
    if (!userData.battleRecord) userData.battleRecord = { wins:0, losses:0 };
    saveUserData({ [body.user_id]: userData });
    await client.chat.postMessage({ channel:body.channel_id, blocks:[
      { type:'section', text:{ type:'mrkdwn', text:`✅ *Hackatime Linked!*\n*Username:* ${stats.username}\n*Total Time:* ${stats.totalMinutes} min\n🖥️ *Language:* ${stats.primaryLanguage||'Unknown'} — influences your encounters!` } },
      { type:'section', text:{ type:'mrkdwn', text:`🎮 *Commands:*\n• \`/catch\` — 1 min, 70% catch chance\n• \`/catch 2\` — 3 min, guaranteed\n• \`/battle @user\` — PvP battle\n• \`/levelup\` — power up Pokémon\n• \`/queststatus\` \`/questclaim\` — daily quests\n• \`/pokestats\` \`/poketeam\` \`/pokedex\`` } },
    ]});
  } catch(e) { console.error('Error in /linkhackatime:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/pokestats', async ({ ack, body, client }) => {
  try {
    await ack();
    const userId = body.user_id;
    const userData = getUserData(userId);
    if (!userData.hacktimeUsername) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Link Hackatime first!' }); return; }
    const stats = await getHackatimeUserStats(userData.hacktimeUsername, userData);
    const available = stats ? stats.totalMinutes - userData.minutesUsedForCatching : 0;
    const br = userData.battleRecord || { wins:0, losses:0 };
    const xpToNext = xpToNextTrainerLevel(userData);
    await client.chat.postMessage({ channel:body.channel_id, blocks:[
      { type:'header', text:{ type:'plain_text', text:'📊 Your Stats', emoji:true } },
      { type:'section', fields:[
        { type:'mrkdwn', text:`*Trainer Level:* ${userData.level}${xpToNext?` (${xpToNext} XP to next)`:' MAX'}` },
        { type:'mrkdwn', text:`*Total XP:* ${userData.xp}` },
        { type:'mrkdwn', text:`*Pokémon Caught:* ${userData.totalCaught}` },
        { type:'mrkdwn', text:`*Pokédex:* ${userData.pokedex.length}/151` },
        { type:'mrkdwn', text:`*Battles Won:* ${br.wins}` },
        { type:'mrkdwn', text:`*Battles Lost:* ${br.losses}` },
      ]},
      { type:'divider' },
      { type:'section', text:{ type:'mrkdwn', text:`*🔗 Hackatime:* ${userData.hacktimeUsername}\n🖥️ Language: *${userData.primaryLanguage||'Unknown'}*\n⏱️ Total: ${stats?stats.totalMinutes:'?'} | Used: ${userData.minutesUsedForCatching} | Available: ${available} min` } },
    ]});
  } catch(e) { console.error('Error in /pokestats:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/poketeam', async ({ ack, body, client }) => {
  try {
    await ack();
    const userData = getUserData(body.user_id);
    if (userData.pokemonTeam.length === 0) { await client.chat.postMessage({ channel:body.channel_id, text:"❌ No Pokémon yet! Use `/catch` to start." }); return; }

    const PAGE_SIZE = 10; // 10 pokemon = 1 header + 10*(label+card+divider) - 1 trailing divider = 30 blocks, safe under 50
    const arg = parseInt(body.text.trim()) || 1;
    const page = Math.max(1, arg);
    const total = userData.pokemonTeam.length;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const safePage = Math.min(page, totalPages);
    const slice = userData.pokemonTeam.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

    const blocks = [{ type:'header', text:{ type:'plain_text', text:`🎯 Your Team (${total}) — Page ${safePage}/${totalPages}`, emoji:true } }];
    slice.forEach((p, i) => {
      const globalIndex = (safePage - 1) * PAGE_SIZE + i + 1;
      blocks.push({ type:'section', text:{ type:'mrkdwn', text:`*#${globalIndex}*` } });
      blocks.push(createPokemonBlock(p, true));
      if (i < slice.length - 1) blocks.push({ type:'divider' }); // no trailing divider
    });

    if (totalPages > 1) {
      blocks.push({ type:'context', elements:[{ type:'mrkdwn', text:`Page ${safePage}/${totalPages} · Use \`/poketeam <page>\` to see more. E.g. \`/poketeam 2\`` }] });
    }

    await client.chat.postMessage({ channel:body.channel_id, blocks });
  } catch(e) { console.error('Error in /poketeam:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/pokedex', async ({ ack, body, client }) => {
  try {
    await ack();
    const userData = getUserData(body.user_id);
    const pct = Math.round((userData.pokedex.length / 151) * 100);
    await client.chat.postMessage({ channel:body.channel_id, blocks:[
      { type:'section', text:{ type:'mrkdwn', text:`*Pokédex* — ${userData.pokedex.length}/151 (${pct}%)` } },
      { type:'context', elements:[{ type:'mrkdwn', text:`${'█'.repeat(Math.floor(pct/5))}${'░'.repeat(20-Math.floor(pct/5))} ${pct}%` }] },
    ]});
  } catch(e) { console.error('Error in /pokedex:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/levelup', async ({ ack, body, client }) => {
  try {
    await ack();
    const userId = body.user_id;
    const userData = getUserData(userId);
    if (userData.pokemonTeam.length === 0) { await client.chat.postMessage({ channel:body.channel_id, text:"❌ No Pokémon to level up!" }); return; }

    const arg = body.text.trim();
    if (!arg) {
      const lines = userData.pokemonTeam.map((p,i) => {
        const lvl = p.pokemonLevel||1;
        const cost = lvl < MAX_POKEMON_LEVEL ? POKEMON_LEVEL_XP_COST[lvl+1] : null;
        return `*${i+1}.* ${p.name} — Lv.${lvl} ${cost?`(costs ${cost} XP)`:'(MAX)'}`;
      }).join('\n');
      await client.chat.postMessage({ channel:body.channel_id, blocks:[{ type:'section', text:{ type:'mrkdwn', text:`*Your Team* — You have *${userData.xp} XP*\n\n${lines}\n\nUse \`/levelup <number>\` to level up. E.g. \`/levelup 1\`` } }] });
      return;
    }

    const index = parseInt(arg,10) - 1;
    if (isNaN(index)||index<0||index>=userData.pokemonTeam.length) { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Pick a number 1–${userData.pokemonTeam.length}` }); return; }

    const res = levelUpPokemon(userData, index);
    if (!res.success) { await client.chat.postMessage({ channel:body.channel_id, text:`❌ ${res.reason}` }); return; }
    saveUserData({ [userId]: userData });
    const pokemon = userData.pokemonTeam[index];
    await client.chat.postMessage({ channel:body.channel_id, blocks:[
      { type:'section', text:{ type:'mrkdwn', text:`⭐ *${pokemon.name} leveled up to Lv.${res.newPokemonLevel}!*\n💸 Cost: ${res.cost} XP | Remaining XP: ${userData.xp}${res.newMove?`\n✨ *Learned: ${res.newMove}!*`:''}` } },
      createPokemonBlock(pokemon, true),
      { type:'context', elements:[{ type:'mrkdwn', text:`+${Math.round(STAT_BOOST_PER_LEVEL*100)}% stats per level. Max: Lv.${MAX_POKEMON_LEVEL}` }] },
    ]});
  } catch(e) { console.error('Error in /levelup:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/queststatus', async ({ ack, body, client }) => {
  try {
    await ack();
    const userData = getUserData(body.user_id);
    const todayKey = new Date().toISOString().slice(0,10);
    if (!userData.dailyQuest || userData.dailyQuest.dateKey !== todayKey) {
      await client.chat.postMessage({ channel:body.channel_id, text:"📋 No quest yet today! Quests arrive each morning via DM." }); return;
    }
    const q = userData.dailyQuest;
    if (q.completed) { await client.chat.postMessage({ channel:body.channel_id, text:`✅ Already completed today's quest! Come back tomorrow.` }); return; }
    let progressText = '';
    if (q.minuteGoal) progressText = `⏱️ ${Math.max(0,(userData.cachedHackatimeMinutes||0)-(q.startMinutes||0))}/${q.minuteGoal} minutes`;
    else if (q.catchGoal) progressText = `🎯 ${Math.max(0,(userData.totalCaught||0)-(q.startCaught||0))}/${q.catchGoal} Pokémon caught`;
    else if (q.battleGoal) progressText = `⚔️ ${Math.max(0,((userData.battleRecord||{}).wins||0)-(q.startWins||0))}/${q.battleGoal} battles won`;
    await client.chat.postMessage({ channel:body.channel_id, blocks:[
      { type:'section', text:{ type:'mrkdwn', text:`*📋 Today's Quest*\n_${q.description}_\n\n${progressText}\n🎁 Reward: *${q.xpReward} XP*` } },
      { type:'context', elements:[{ type:'mrkdwn', text:'Use `/questclaim` to collect when done!' }] },
    ]});
  } catch(e) { console.error('Error in /queststatus:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/questclaim', async ({ ack, body, client }) => {
  try {
    await ack();
    const userId = body.user_id;
    const userData = getUserData(userId);
    const todayKey = new Date().toISOString().slice(0,10);
    if (!userData.dailyQuest || userData.dailyQuest.dateKey !== todayKey) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ No active quest today!' }); return; }
    const q = userData.dailyQuest;
    if (q.completed) { await client.chat.postMessage({ channel:body.channel_id, text:"✅ Already claimed today's reward!" }); return; }

    let completed = false, progressText = '';
    if (q.minuteGoal) {
      const stats = await getHackatimeUserStats(userData.hacktimeUsername, userData);
      const gained = (stats?stats.totalMinutes:userData.cachedHackatimeMinutes) - (q.startMinutes||0);
      completed = gained >= q.minuteGoal; progressText = `${Math.max(0,gained)}/${q.minuteGoal} min`;
    } else if (q.catchGoal) {
      const gained = (userData.totalCaught||0) - (q.startCaught||0);
      completed = gained >= q.catchGoal; progressText = `${Math.max(0,gained)}/${q.catchGoal} caught`;
    } else if (q.battleGoal) {
      const gained = ((userData.battleRecord||{}).wins||0) - (q.startWins||0);
      completed = gained >= q.battleGoal; progressText = `${Math.max(0,gained)}/${q.battleGoal} wins`;
    }

    if (!completed) { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Not done yet! Progress: ${progressText}` }); return; }
    q.completed = true;
    const { leveled, newLevel } = addTrainerXp(userData, q.xpReward);
    saveUserData({ [userId]: userData });
    await client.chat.postMessage({ channel:body.channel_id, blocks:[
      { type:'section', text:{ type:'mrkdwn', text:`🎉 *Quest Complete!*\n_${q.description}_\n\n🎁 +${q.xpReward} XP!${leveled?`\n🎊 *Trainer Level Up → Lv.${newLevel}!*`:''}\nTotal XP: ${userData.xp}` } },
      { type:'context', elements:[{ type:'mrkdwn', text:'New quest tomorrow morning!' }] },
    ]});
  } catch(e) { console.error('Error in /questclaim:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

app.command('/battle', async ({ ack, body, client }) => {
  try {
    await ack();
    const challengerId = body.user_id;
    const challengerData = getUserData(challengerId);
    if (!challengerData.hacktimeUsername) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Link Hackatime first!' }); return; }
    if (challengerData.pokemonTeam.length === 0) { await client.chat.postMessage({ channel:body.channel_id, text:"❌ No Pokémon! Use `/catch` first." }); return; }
    const match = body.text.trim().match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
    if (!match) { await client.chat.postMessage({ channel:body.channel_id, text:'❌ Usage: `/battle @username`' }); return; }
    const challengedId = match[1];
    if (challengedId === challengerId) { await client.chat.postMessage({ channel:body.channel_id, text:"❌ Can't battle yourself!" }); return; }
    const challengedData = getUserData(challengedId);
    if (!challengedData.hacktimeUsername) { await client.chat.postMessage({ channel:body.channel_id, text:`❌ <@${challengedId}> hasn't linked Hackatime yet!` }); return; }
    if (challengedData.pokemonTeam.length === 0) { await client.chat.postMessage({ channel:body.channel_id, text:`❌ <@${challengedId}> has no Pokémon!` }); return; }
    const challengerPokemon = challengerData.pokemonTeam.reduce((best,p) => Object.values(getBoostedStats(p)).reduce((a,b)=>a+b,0) > Object.values(getBoostedStats(best)).reduce((a,b)=>a+b,0) ? p : best);
    const battleKey = `${challengerId}-${challengedId}-${Date.now()}`;
    pendingChallenges.set(battleKey, { challengerId, challengedId, challengerPokemon, channelId:body.channel_id, expiresAt:Date.now()+5*60*1000 });
    for (const [k,v] of pendingChallenges.entries()) { if (v.expiresAt < Date.now()) pendingChallenges.delete(k); }
    await client.chat.postMessage({ channel:body.channel_id, blocks:buildChallengeBlocks(challengerId, challengerPokemon, challengedId, battleKey) });
  } catch(e) { console.error('Error in /battle:', e); try { await client.chat.postMessage({ channel:body.channel_id, text:`❌ Error: ${e.message}` }); } catch(_){} }
});

// == interactions ==

app.action('accept_battle', async ({ ack, body, client, action }) => {
  try {
    await ack();
    const challenge = pendingChallenges.get(action.value);
    if (!challenge) { await client.chat.postMessage({ channel:body.channel.id, text:'⌛ Challenge expired or already resolved.' }); return; }
    if (body.user.id !== challenge.challengedId) return;
    if (Date.now() > challenge.expiresAt) { pendingChallenges.delete(action.value); await client.chat.postMessage({ channel:body.channel.id, text:`⌛ Challenge expired.` }); return; }
    pendingChallenges.delete(action.value);

    const challengedData = getUserData(challenge.challengedId);
    const challengerData = getUserData(challenge.challengerId);
    const challengedPokemon = challengedData.pokemonTeam.reduce((best,p) => Object.values(getBoostedStats(p)).reduce((a,b)=>a+b,0) > Object.values(getBoostedStats(best)).reduce((a,b)=>a+b,0) ? p : best);

    await client.chat.update({ channel:body.channel.id, ts:body.message.ts, blocks:[{ type:'section', text:{ type:'mrkdwn', text:`⚔️ *Battle accepted!* <@${challenge.challengedId}> sends *${challengedPokemon.name}* (Lv.${challengedPokemon.pokemonLevel||1})!\n\n🎲 _Simulating..._` } }] });

    const result = simulateBattle(challenge.challengerPokemon, challengedPokemon);
    if (!challengerData.battleRecord) challengerData.battleRecord = { wins:0, losses:0 };
    if (!challengedData.battleRecord) challengedData.battleRecord = { wins:0, losses:0 };
    if (result.winnerIsP1) { challengerData.battleRecord.wins++; challengedData.battleRecord.losses++; addTrainerXp(challengerData,100); addTrainerXp(challengedData,25); }
    else { challengedData.battleRecord.wins++; challengerData.battleRecord.losses++; addTrainerXp(challengedData,100); addTrainerXp(challengerData,25); }
    saveUserData({ [challenge.challengerId]:challengerData, [challenge.challengedId]:challengedData });
    await client.chat.postMessage({ channel:body.channel.id, blocks:buildBattleResultBlocks(challenge.challengerId, challenge.challengedId, challenge.challengerPokemon, challengedPokemon, result) });
  } catch(e) { console.error('Error in accept_battle:', e); try { await client.chat.postMessage({ channel:body.channel.id, text:`❌ Battle error: ${e.message}` }); } catch(_){} }
});

app.action('decline_battle', async ({ ack, body, client, action }) => {
  try {
    await ack();
    const challenge = pendingChallenges.get(action.value);
    if (!challenge || body.user.id !== challenge.challengedId) return;
    pendingChallenges.delete(action.value);
    await client.chat.update({ channel:body.channel.id, ts:body.message.ts, blocks:[{ type:'section', text:{ type:'mrkdwn', text:`❌ <@${challenge.challengedId}> declined the challenge from <@${challenge.challengerId}>. 😔` } }] });
  } catch(e) { console.error('Error in decline_battle:', e); }
});

// == scheduling ==

async function startSchedulers(client) {
  console.log('🌿 Starting wild spawn scheduler (every 1 hour)');
  spawnWildPokemon(client); // Spawn immediately on boot
  setInterval(() => spawnWildPokemon(client), WILD_SPAWN_INTERVAL); // FIX: was WILD_SPAWN_INTERVAL_MS

  // Daily quests at 9am IST = 3:30am UTC
  function scheduleNextQuestSend() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(3, 30, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next - now;
    console.log(`📋 Next daily quests in ${Math.round(delay/60000)} min`);
    setTimeout(async () => { await sendDailyQuests(client); scheduleNextQuestSend(); }, delay);
  }
  scheduleNextQuestSend();
}

// == server ==

receiver.app.listen(process.env.PORT || 3000, () => {
  console.log('⚡️ HTTP server running on port', process.env.PORT || 3000);
});

app.start().then(async () => {
  console.log("🤖 GottaHackEm'All Pokémon Bot is ready!");
  await startSchedulers(app.client);
}).catch(error => {
  console.error('Failed to start app:', error);
  process.exit(1);
});
