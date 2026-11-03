import { world, system, Player, CommandPermissionLevel, CustomCommandStatus, CustomCommandParamType } from "@minecraft/server";
import { hasAdminPermission, findPlayerByName } from "./playerUtils.js";
import { Version, DevBuild } from "../const.js";
import { Database } from "../database.js";
import { SuperDB as DataStorageManager, WorldData, PlayerData } from "../core/SuperDB.js";
import { claimCurrentChunk, endAreaClaimSelection, showMyClaimsMenu, startAreaClaimSelection, unclaimCurrentChunk } from './functions/landclaim.js'
import { handleRTPInstantCommand } from "./functions/rtp.js";
import * as adminCommands from "./functions/adminCommands.js";
import * as vanishSystem from "./functions/vanishSystem.js";
import * as warningSystem from "./functions/warningSystem.js";
import * as loreSystem from "./functions/loreSystem.js";
import * as broadcastSystem from "./functions/broadcastSystem.js";
import * as codeSystem from "./functions/codeSystem.js";
import * as kitSystem from '../kits_2.0.js';
import { setPlayerAFK } from '../afk.js';
import { handlePayCommand, checkBalance } from "./functions/pay.js";
import { handleWithdrawCommand } from "./functions/withdraw.js";
import { canPlayerUseCustomCommand, getStoredCommands } from "../uis/admin/custom_commands.js";
import { nickName } from "../handlers/nicknameHandler.js";
import { ShopSystem } from "../uis/community_panel/player_shops.js";
import { Settings } from "../uis/admin/admin_settings.js";
import { Color, Formatting } from "./functions/colors.js";
import { permissionManager } from "../handlers/permissionManager.js";
import { hasOwner, isOwner, setOwner, removeOwner, getOwner } from "../dev/helperFunctions.js";
import { setTimePlayedByName, parseTimeString, formatTime } from "../handlers/TimePlayedHandler.js";
import { showChangelogsMenu } from "../uis/community_panel/changelogs.js";
import { handlePartyCommand, showPartyMenu } from "../uis/community_panel/partySystem.js";
import { showCrateMenu } from "../uis/admin/crates.js";
import { handleCreativePlotCommand, isPlayerInCreativePlot } from "./functions/creative_plots.js";
import { handleWorldBorderCommand } from "./functions/worldborder.js";
import { setCommandActions } from "./slashCommands.js";
import { RankColorUI } from "../handlers/rankColorHandler.js";

const systemDB = new Database("system");

// Sudo session tracking - maps admin player ID to target player ID
export const sudoSessions = new Map();

export function Bad(player) {
  system.run(() => {
    player.runCommand("playsound note.bass @s");
  });
}

export function Good(player) {
  system.run(() => {
    player.runCommand("playsound note.pling @s");
  });
}

// DataStorageManager is now imported from ../core/SuperDB.js

class CommandSystemManager extends DataStorageManager {
  constructor() {
    super("admin_settings");
  }

  getPrefix() {
    try {
      return Settings.getSetting('chatPrefix', '!');
    } catch (e) {
      console.error("[CommandSystem] Error loading prefix:", e);
      return "!";
    }
  }

  setPrefix(newPrefix) {
    try {
      return Settings.setSetting('chatPrefix', newPrefix);
    } catch (error) {
      console.error("[CommandSystem] Error saving prefix:", error);
      return false;
    }
  }

  getChatLock() {
    try {
      return Settings.getSetting('chatLock', false);
    } catch (e) {
      console.error("[CommandSystem] Error loading chat lock:", e);
      return false;
    }
  }

  setChatLock(locked) {
    try {
      return Settings.setSetting('chatLock', locked);
    } catch (error) {
      console.error("[CommandSystem] Error saving chat lock:", error);
      return false;
    }
  }
}

const commandSystemManager = new CommandSystemManager();

class LastSeenManager extends DataStorageManager {
  constructor() {
    super("lastseen");
  }

  // ==================== PLAYER ID MIGRATION ====================

  /**
   * Migrate player data from name-based to ID-based storage
   * Called on player spawn
   */
  migratePlayerToId(player) {
    try {
      const lastSeenData = this.getData('player_activity') || {};
      const playerId = player.id;
      const playerName = player.name;
      const nameLower = playerName.toLowerCase();

      // Check if already migrated (data exists under player.id)
      if (lastSeenData[playerId]) {
        // Update display name if changed
        if (lastSeenData[playerId].displayName !== playerName) {
          lastSeenData[playerId].displayName = playerName;
          this.setData('player_activity', 'Player Activity', lastSeenData);
        }
        return;
      }

      // Check if data exists under old name-based key
      if (lastSeenData[nameLower]) {
        console.warn(`[LastSeenManager] Migrating ${playerName} from name to ID...`);
        const oldData = lastSeenData[nameLower];

        // Migrate to ID-based key
        lastSeenData[playerId] = {
          displayName: playerName,
          playerId: playerId,
          lastSeen: oldData.lastSeen,
          isOnline: true,
          firstSeen: oldData.firstSeen || oldData.lastSeen
        };

        // Remove old name-based entry
        delete lastSeenData[nameLower];

        this.setData('player_activity', 'Player Activity', lastSeenData);
        console.warn(`[LastSeenManager] Migrated ${playerName} to ID ${playerId}`);
      }
    } catch (error) {
      console.error("[LastSeenManager] Error migrating player to ID:", error);
    }
  }

  /**
   * Update player activity. Accepts either:
   * - Player object (preferred, enables ID-based storage)
   * - String playerName (fallback for events that only provide name)
   */
  updatePlayerActivity(playerOrName) {
    try {
      const currentTime = Date.now();
      const lastSeenData = this.getData('player_activity') || {};

      // Check if we have a player object or just a name string
      if (typeof playerOrName === 'object' && playerOrName.id) {
        // We have a full player object - use ID-based storage
        const player = playerOrName;
        const playerId = player.id;

        // Migrate from name-based if needed
        if (!lastSeenData[playerId] && lastSeenData[player.name.toLowerCase()]) {
          this.migratePlayerToId(player);
        }

        lastSeenData[playerId] = {
          displayName: player.name,
          playerId: playerId,
          lastSeen: currentTime,
          isOnline: true,
          firstSeen: lastSeenData[playerId]?.firstSeen || currentTime
        };
      } else {
        // Only have player name string - use name temporarily 
        // Migration will happen on next spawn when we have player object
        const playerName = typeof playerOrName === 'string' ? playerOrName : playerOrName.name;
        const nameLower = playerName.toLowerCase();

        // Check if we already have ID-based data for this name
        let foundById = false;
        for (const [id, data] of Object.entries(lastSeenData)) {
          if (data.displayName && data.displayName.toLowerCase() === nameLower) {
            // Update the ID-based entry
            lastSeenData[id].lastSeen = currentTime;
            lastSeenData[id].isOnline = true;
            foundById = true;
            break;
          }
        }

        if (!foundById) {
          // No ID-based data found, use name key (legacy format)
          lastSeenData[nameLower] = {
            name: playerName,
            displayName: playerName,
            lastSeen: currentTime,
            isOnline: true,
            firstSeen: lastSeenData[nameLower]?.firstSeen || currentTime
          };
        }
      }

      this.setData('player_activity', 'Player Activity', lastSeenData);
    } catch (error) {
      console.error("[LastSeenManager] Error updating player activity:", error);
    }
  }

  /**
   * Set player offline. Accepts either:
   * - Player object (preferred, enables ID-based storage)
   * - String playerName (fallback for events that only provide name)
   */
  setPlayerOffline(playerOrName) {
    try {
      const currentTime = Date.now();
      const lastSeenData = this.getData('player_activity') || {};

      if (typeof playerOrName === 'object' && playerOrName.id) {
        // We have a full player object
        const playerId = playerOrName.id;
        if (lastSeenData[playerId]) {
          lastSeenData[playerId].lastSeen = currentTime;
          lastSeenData[playerId].isOnline = false;
          lastSeenData[playerId].displayName = playerOrName.name;
          this.setData('player_activity', 'Player Activity', lastSeenData);
        }
      } else {
        // Only have player name string
        const playerName = typeof playerOrName === 'string' ? playerOrName : playerOrName.name;
        const nameLower = playerName.toLowerCase();

        // First try to find by ID (displayName match)
        let found = false;
        for (const [id, data] of Object.entries(lastSeenData)) {
          if (data.displayName && data.displayName.toLowerCase() === nameLower) {
            lastSeenData[id].lastSeen = currentTime;
            lastSeenData[id].isOnline = false;
            found = true;
            break;
          }
        }

        // Fallback to name-based key
        if (!found && lastSeenData[nameLower]) {
          lastSeenData[nameLower].lastSeen = currentTime;
          lastSeenData[nameLower].isOnline = false;
        }

        this.setData('player_activity', 'Player Activity', lastSeenData);
      }
    } catch (error) {
      console.error("[LastSeenManager] Error setting player offline:", error);
    }
  }

  /**
   * Get player data by name (searches by displayName for compatibility)
   */
  getPlayerDataByName(playerName) {
    try {
      const lastSeenData = this.getData('player_activity') || {};
      const nameLower = playerName.toLowerCase();

      // First check for legacy name-based entry
      if (lastSeenData[nameLower]) {
        return lastSeenData[nameLower];
      }

      // Search by displayName in ID-based entries
      for (const [id, data] of Object.entries(lastSeenData)) {
        if (data.displayName && data.displayName.toLowerCase() === nameLower) {
          return data;
        }
      }

      return null;
    } catch (error) {
      console.error("[LastSeenManager] Error getting player data:", error);
      return null;
    }
  }

  formatTimeDifference(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const years = Math.floor(days / 365);

    const parts = [];

    if (years > 0) {
      parts.push(years === 1 ? '1 year' : `${years} years`);
    }
    if (days % 365 > 0) {
      const dayCount = days % 365;
      parts.push(dayCount === 1 ? '1 day' : `${dayCount} days`);
    }
    if (hours % 24 > 0) {
      const hourCount = hours % 24;
      parts.push(hourCount === 1 ? '1 hour' : `${hourCount} hours`);
    }
    if (minutes % 60 > 0 && days === 0 && years === 0) {
      const minuteCount = minutes % 60;
      parts.push(minuteCount === 1 ? '1 minute' : `${minuteCount} minutes`);
    }

    if (parts.length === 0) {
      return '1 minute';
    } else if (parts.length === 1) {
      return parts[0];
    } else if (parts.length === 2) {
      return `${parts[0]} and ${parts[1]}`;
    } else if (parts.length === 3) {
      return `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
    } else {
      return `${parts[0]}, ${parts[1]}, ${parts[2]}, and ${parts[3]}`;
    }
  }
}

const lastSeenManager = new LastSeenManager();

function handleLastSeenCommand(player, args) {
  try {
    // Join all arguments after the command to handle spaces in usernames
    const targetName = args.slice(1).join(' ').trim();

    if (!targetName) {
      player.sendMessage("§cUsage: !lastseen [player]");
      Bad(player);
      return true;
    }

    // Check if player is currently online
    const onlinePlayer = world.getAllPlayers().find(p =>
      p.name.toLowerCase() === targetName.toLowerCase()
    );

    if (onlinePlayer) {
      player.sendMessage(`§a${onlinePlayer.name} is currently online and playing`);
      //Good(player);
      return true;
    }

    // Check database for offline player
    const playerData = lastSeenManager.getPlayerDataByName(targetName);

    if (!playerData) {
      player.sendMessage(`§c${targetName} was not found!`);
      Bad(player);
      return true;
    }

    const timeDiff = Date.now() - playerData.lastSeen;
    const formattedTime = lastSeenManager.formatTimeDifference(timeDiff);

    player.sendMessage(`§a${playerData.name} was last seen ${formattedTime} ago`);
    //Good(player);
    return true;

  } catch (error) {
    console.error("[LastSeen] Error handling command:", error);
    player.sendMessage("§cAn error occurred while checking last seen data.");
    Bad(player);
    return true;
  }
}

function handleXpGetCommand(player, args) {
  try {
    // Join all arguments after the command to handle spaces in usernames
    const targetName = args.slice(1).join(' ').trim();

    if (!targetName) {
      player.sendMessage("§cUsage: !xpget [player]");
      Bad(player);
      return true;
    }

    // Find the target player
    const targetPlayer = world.getAllPlayers().find(p =>
      p.name.toLowerCase() === targetName.toLowerCase()
    );

    if (!targetPlayer) {
      player.sendMessage(`§c${targetName} was not found!`);
      Bad(player);
      return true;
    }

    // Get the player's XP level
    const playerLevel = targetPlayer.level;
    const playerXpProgress = targetPlayer.xpEarnedAtCurrentLevel;
    const totalXpNeeded = targetPlayer.totalXpNeededForNextLevel;

    // Handle singular/plural for levels
    const levelText = playerLevel === 1 ? "level" : "levels";

    // Send the XP information
    player.sendMessage(`§a${targetPlayer.name} has §e${playerLevel} ${levelText}§a (${playerXpProgress}/${totalXpNeeded} XP to next level)`);
    Good(player);
    return true;

  } catch (error) {
    console.error("[XpGet] Error handling command:", error);
    player.sendMessage("§cAn error occurred while checking XP data.");
    Bad(player);
    return true;
  }
}

function handleNickResetCommand(player, args) {
  try {
    if (args.length < 2) {
      player.sendMessage("§cUsage: !nickreset [player]");
      Bad(player);
      return true;
    }

    let targetName = args.slice(1).join(' ').trim();
    // Remove @ and quotes from player name
    targetName = targetName.replace(/^@"?([^"]*)"?$/, '$1').trim();

    const targetPlayer = world.getAllPlayers().find(p =>
      p.name.toLowerCase() === targetName.toLowerCase()
    );

    if (!targetPlayer) {
      player.sendMessage(`§c${targetName} was not found!`);
      Bad(player);
      return true;
    }

    system.run(() => {
      targetPlayer.nameTag = targetPlayer.name;
      PlayerData.set(targetPlayer, 'realm:nickname', null);
    });

    player.sendMessage(`§a✓ Reset ${targetPlayer.name}'s nickname to their default name.`);
    targetPlayer.sendMessage(`§cAn admin has reset your nickname to your default name.`);
    Good(player);
    return true;

  } catch (error) {
    console.error("[NickReset] Error handling command:", error);
    player.sendMessage("§cAn error occurred while resetting the nickname.");
    Bad(player);
    return true;
  }
}

function handleNickSetCommand(player, args) {
  try {
    if (args.length < 3) {
      player.sendMessage("§cUsage: !nickset [player] [nickname]");
      Bad(player);
      return true;
    }

    let targetName = args[1];
    // Remove @ and quotes from player name
    targetName = targetName.replace(/^@"?([^"]*)"?$/, '$1').trim();

    const newNickname = args.slice(2).join(' ');

    const targetPlayer = world.getAllPlayers().find(p =>
      p.name.toLowerCase() === targetName.toLowerCase()
    );

    if (!targetPlayer) {
      player.sendMessage(`§c${targetName} was not found!`);
      Bad(player);
      return true;
    }

    if (newNickname.length > 32) {
      player.sendMessage("§cNickname must be 32 characters or less.");
      Bad(player);
      return true;
    }

    system.run(() => {
      targetPlayer.nameTag = newNickname;
      PlayerData.set(targetPlayer, 'realm:nickname', newNickname);
    });

    player.sendMessage(`§a✓ Set ${targetPlayer.name}'s nickname to: §r${newNickname}`);
    targetPlayer.sendMessage(`§cAn admin has set your nickname to: §r${newNickname}`);
    Good(player);
    return true;

  } catch (error) {
    console.error("[NickSet] Error handling command:", error);
    player.sendMessage("§cAn error occurred while setting the nickname.");
    Bad(player);
    return true;
  }
}

function handleSudoCommand(player, args) {
  try {
    if (args.length < 2) {
      player.sendMessage("§cUsage: !sudo [player]");
      Bad(player);
      return true;
    }

    // Prevent concurrent sudo sessions (race condition prevention)
    if (sudoSessions.has(player.id)) {
      player.sendMessage("§cYou are already in sudo mode! Use §b!sudoexit §cto exit first.");
      Bad(player);
      return true;
    }

    let targetName = args.slice(1).join(' ').trim();
    // Remove @ and quotes from player name
    targetName = targetName.replace(/^@"?([^"]*)"?$/, '$1').trim();

    const targetPlayer = world.getAllPlayers().find(p =>
      p.name.toLowerCase() === targetName.toLowerCase()
    );

    if (!targetPlayer) {
      player.sendMessage(`§c${targetName} was not found!`);
      Bad(player);
      return true;
    }

    if (targetPlayer.id === player.id) {
      player.sendMessage("§cYou cannot sudo as yourself!");
      Bad(player);
      return true;
    }

    // Set sudo session
    sudoSessions.set(player.id, targetPlayer.id);

    player.sendMessage(`§a✓ You are now impersonating §r${targetPlayer.name}§a. Use §b!sudoexit §ato stop.`);
    player.sendMessage(`§7§oAll messages you type will be sent as ${targetPlayer.name}. Ranks and display name will be mocked.`);
    Good(player);
    return true;

  } catch (error) {
    console.error("[Sudo] Error handling command:", error);
    player.sendMessage("§cAn error occurred while activating sudo mode.");
    Bad(player);
    return true;
  }
}

function handleSudoExitCommand(player, args) {
  try {
    if (!sudoSessions.has(player.id)) {
      player.sendMessage("§cYou are not currently in sudo mode!");
      Bad(player);
      return true;
    }

    const targetId = sudoSessions.get(player.id);
    sudoSessions.delete(player.id);

    const targetPlayer = world.getAllPlayers().find(p => p.id === targetId);
    const targetName = targetPlayer ? targetPlayer.name : "unknown player";

    player.sendMessage(`§a✓ Exited sudo mode. You are no longer impersonating §r${targetName}§a.`);
    Good(player);
    return true;

  } catch (error) {
    console.error("[SudoExit] Error handling command:", error);
    player.sendMessage("§cAn error occurred while exiting sudo mode.");
    Bad(player);
    return true;
  }
}

// Private chat session tracking - maps player name to partner name
const activeChats = new Map();

const CHAT_MESSAGE_PREFIX_SENDER = "§7[You -> ";
const CHAT_MESSAGE_PREFIX_RECEIVER = "§7[";
const CHAT_MESSAGE_SUFFIX = "]§r ";
const ERROR_PREFIX = "§c";
const SUCCESS_PREFIX = "§a";
const INFO_PREFIX = "§e";

function findPlayerByName(name) {
  for (const player of world.getPlayers()) {
    if (player.name === name) {
      return player;
    }
  }
  return undefined;
}

function handleChatCommand(player, args) {
  const cmdPrefix = commandSystemManager.getPrefix();

  if (!args[1]) {
    player.sendMessage(`${ERROR_PREFIX}Usage: ${cmdPrefix}chat <@username>`);
    return true;
  }

  const targetNameArg = args[1];
  const cleanTargetName = targetNameArg.replace(/^@"?([^"]*)"?$/, '$1');

  if (cleanTargetName === player.name) {
    player.sendMessage(`${ERROR_PREFIX}You cannot start a private chat with yourself.`);
    return true;
  }

  if (activeChats.has(player.name)) {
    player.sendMessage(`${ERROR_PREFIX}You are already in a private chat with ${activeChats.get(player.name)}. Type ${cmdPrefix}endchat to leave.`);
    return true;
  }

  const targetPlayer = findPlayerByName(cleanTargetName);
  if (!targetPlayer) {
    player.sendMessage(`${ERROR_PREFIX}Player "${cleanTargetName}" is not online.`);
    Bad(player);
    return true;
  }

  if (activeChats.has(targetPlayer.name)) {
    player.sendMessage(`${ERROR_PREFIX}${targetPlayer.name} is already in another private chat.`);
    return true;
  }

  activeChats.set(player.name, targetPlayer.name);
  activeChats.set(targetPlayer.name, player.name);

  player.sendMessage(`${SUCCESS_PREFIX}You are now privately chatting with ${targetPlayer.name}. Type ${cmdPrefix}endchat to end the chat.`);
  targetPlayer.sendMessage(`${SUCCESS_PREFIX}${player.name} has started a private chat with you. Type ${cmdPrefix}endchat to end the chat.`);
  Good(player);
  return true;
}

function handleEndchatCommand(player, args) {
  const currentPartnerName = activeChats.get(player.name);
  if (!currentPartnerName) {
    player.sendMessage(`${ERROR_PREFIX}You are not currently in a private chat.`);
    Bad(player);
    return true;
  }

  const partnerPlayer = findPlayerByName(currentPartnerName);

  activeChats.delete(player.name);
  activeChats.delete(currentPartnerName);

  player.sendMessage(`${INFO_PREFIX}You have ended the private chat with ${currentPartnerName}.`);
  if (partnerPlayer) {
    partnerPlayer.sendMessage(`${INFO_PREFIX}${player.name} has ended the private chat.`);
  }
  Good(player);
  return true;
}

// Check if a player is in a private chat
export function isInPrivateChatSession(playerName) {
  return activeChats.has(playerName);
}

// Get the partner name for a player in a private chat
export function getPrivateChatPartner(playerName) {
  return activeChats.get(playerName);
}

// Clean up private chats when players leave
world.afterEvents.playerLeave.subscribe(event => {
  const leavingPlayerName = event.playerName;
  if (activeChats.has(leavingPlayerName)) {
    const partnerName = activeChats.get(leavingPlayerName);

    activeChats.delete(leavingPlayerName);
    if (activeChats.has(partnerName)) {
      activeChats.delete(partnerName);
      const partnerPlayer = world.getPlayers().find(p => p.name === partnerName);
      if (partnerPlayer) {
        partnerPlayer.sendMessage(`§e${leavingPlayerName} has left the game. Your private chat has ended.`);
      }
    }
    console.warn(`[PrivateChat] Cleaned up active chat for disconnected player: ${leavingPlayerName} and their partner ${partnerName}`);
  }
});

export const builtInCommands = [
  {
    command: "enchant",
    description:
      "Enchants your items, put commas after the level to add more enchants",
    args: ["[EnchantName]", "[Level]"],
    type: "admin",
    action: (player, args) => { return true; },
  },
  {
    command: "command",
    description: "Allows non op users to run commands",
    args: ["[command]"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !command [command]");
        Bad(player);
        return true;
      } else {
        const commandToRun = args.slice(1).join(" ");
        system.run(() => {
          player.runCommand(commandToRun);
        });
        player.sendMessage(`§aRan command: §b${commandToRun}`);
        return true;
      }
    },
  },
  {
    command: "clearchat",
    aliases: ["cc"],
    description: "Clears your chat",
    args: [],
    type: "player",
    action: (player, args) => {
      system.run(() => {
        // Send multiple messages via tellraw to avoid action bar display
        for (let i = 0; i < 100; i++) {
          player.runCommand(`tellraw @s {"rawtext":[{"text":"clearchat-nperma"}]}`);
        }
      });
      system.runTimeout(() => {
        player.sendMessage(`§r§aSuccessfully cleared chat.`);
        player.playSound("random.orb");
      }, 5);
      return true;
    },
  },
  {
    command: "kick",
    description: "Kicks a player with a reason",
    args: ["[player]", "[reason]"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !kick [player] [reason]");
        Bad(player);
        return true;
      }
      return adminCommands.kickPlayer(player, args);
    },
  },
  {
    command: "broadcast",
    aliases: ["bc"],
    description: "Broadcasts a message to the entire server",
    args: ["[message]"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !broadcast [message]");
        Bad(player);
        return true;
      }
      return broadcastSystem.broadcast(player, args.slice(1).join(" "), args);
    },
  },

  {
    command: 'admintoggle',
    aliases: ['at'],
    description: "Toggles admin mode, which saves your inventory and puts you in GMC",
    type: "admin",
    action: (player) => {
      adminCommands.adminToggle(player)
    }
  },
  {
    command: "warn",
    description: "Warns a player",
    args: ["[player]", "[reason]"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !warn [player] [reason]");
        Bad(player);
        return true;
      }
      return warningSystem.warnPlayer(player, args);
    },
  },
  {
    command: "vanish",
    aliases: ["v"],
    description: "Vanishes the admin",
    args: [],
    type: "admin",
    action: (player, args) => {
      return vanishSystem.toggleVanish(player);
    },
  },
  {
    command: "addlore",
    description: "Adds lore to an item",
    args: ["[lore text]"],
    type: "admin",
    action: (player, args, mainHandItem) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !addlore [lore text]");
        Bad(player);
        return true;
      }
      return loreSystem.addLore(player, args, mainHandItem);
    },
  },
  {
    command: "removelore",
    description: "Removes lore from an item",
    args: [],
    type: "admin",
    action: (player, args, mainHandItem) => {
      return loreSystem.removeLore(player, mainHandItem);
    },
  },
  {
    command: "coinflip",
    description: "Flips a coin and announces the result globally",
    args: [],
    type: "admin",
    action: (player, args) => {
      return adminCommands.coinFlip(player);
    },
  },
  {
    command: "adminpanel",
    aliases: ["ap"],
    description: "Gives the admin panel",
    type: "admin",
    action: (player, args) => {
      if (hasItem(player, "idk:admin_panel", 1)) {
        player.sendMessage("§cYOU ALREADY HAVE A BOOK!");
      } else {
        system.run(() => {
          player.runCommand("give @s idk:admin_panel");
        });
        player.sendMessage(
          "§cIf you did not receive the book then your inventory is full"
        );
      }
      return true;
    }
  },
  {
    command: "addcode",
    description: "Adds a redemption code.",
    args: ["[id]", "[uses]", "[oncePerPlayer (true/false)]", "[command]"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 5) {
        player.sendMessage(
          "§cUsage: !addcode [id] [uses] [true/false for oncePerPlayer] [command]"
        );
        Bad(player);
        return true;
      }
      codeSystem.addCode(player, args);
      return true;
    },
  },
  {
    command: "deletecode",
    description: "Deletes a redemption code.",
    args: ["[id]"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !deletecode [id]");
        Bad(player);
        return true;
      }
      codeSystem.deleteCode(player, args);
      return true;
    },
  },
  {
    command: "listcodes",
    description: "Lists all redemption codes and their uses.",
    args: [],
    type: "admin",
    action: (player, args) => {
      codeSystem.listCodes(player);
      return true;
    },
  },
  {
    command: "settimeplayed",
    aliases: ["stp", "restoretime"],
    description: "Sets/restores a player's time played",
    args: ["<player>", "<time>"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 3) {
        player.sendMessage("§cUsage: !settimeplayed <player> <time>");
        player.sendMessage("§7Time formats: 5h30m, 2d, 3600 (seconds)");
        Bad(player);
        return true;
      }
      const targetName = args[1];
      const timeArg = args.slice(2).join("");
      const seconds = parseTimeString(timeArg);

      if (seconds === null || seconds < 0) {
        player.sendMessage("§cInvalid time format. Use: 5h30m, 2d, or seconds");
        Bad(player);
        return true;
      }

      const result = setTimePlayedByName(targetName, seconds);
      if (result.success) {
        player.sendMessage(`§a${result.message}`);
        Good(player);
      } else {
        player.sendMessage(`§c${result.message}`);
        Bad(player);
      }
      return true;
    },
  },
  {
    command: "code",
    description: "Redeems a code.",
    args: ["[id]"],
    type: "player",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !code [id]");
        Bad(player);
        return true;
      }
      codeSystem.executeCode(player, args);
      return true;
    },
  },
  {
    command: 'save-kit',
    description: 'Saves your inventory as a kit.',
    args: ['<name>'],
    type: 'admin',
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage('§cUsage: !save-kit <name>');
        Bad(player);
        return true;
      }
      kitSystem.handleSaveKitCommand(player, args);
      return true;
    }
  },
  {
    command: 'kits',
    description: 'Lists all available kits.',
    args: [],
    type: 'player',
    action: (player, args) => {
      kitSystem.handleListKitsCommand(player);
      return true;
    }
  },
  {
    command: 'kit',
    description: 'Claims a specified kit.',
    args: ['<kitname>'],
    type: 'player',
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage('§cUsage: !kit <kitname>');
        Bad(player);
        return true;
      }
      kitSystem.handleGiveKitCommand(player, args);
      return true;
    }
  },
  {
    command: 'dev-debug',
    description: 'Toggles developer debug information.',
    args: [],
    type: 'dev',
    action: (player, args) => {
      kitSystem.handleDevDebugCommand(player);
      return true;
    }
  },
  {
    command: "devcheck",
    description: "Checks if the player is a dev",
    args: [],
    type: "dev",
    action: (player, args) => {
      player.sendMessage(`${PlayerData.get(player, "isDev", false)}`);
      return true;
    },
  },
  {
    command: "startupreset",
    aliases: ["sr"],
    description: "Sets the startup message system to false",
    args: [],
    type: "dev",
    action: (player, args) => {
      systemDB.set("config", "StartupComplete", false);
      player.sendMessage("§aStartup message reset complete");
      return true;
    },
  },
  {
    command: "help",
    aliases: ["h"],
    description: "Gives an active list of all commands",
    args: [],
    type: "player",
    action: (player, args) => {
      displayHelpCommand(player);
      return true;
    },
  },
  {
    command: "adminhelp",
    aliases: ["ah", "adc"],
    description: "Shows admin commands list",
    args: [],
    type: "admin",
    action: (player, args) => {
      displayAdminHelpCommand(player);
      return true;
    },
  },
  {
    command: "crate",
    aliases: ["crates"],
    description: "Opens the crate management menu",
    args: [],
    type: "admin",
    action: (player, args) => {
      showCrateMenu(player);
      return true;
    },
  },
  {
    command: "book",
    aliases: ["b"],
    description: "Gives the Community Panel book",
    args: [],
    type: "player",
    action: (player, args) => {
      if (hasItem(player, "idk:community_panel", 1)) {
        player.sendMessage("§cYOU ALREADY HAVE A BOOK!");
      } else {
        system.run(() => {
          player.runCommand("give @s idk:community_panel");
        });
        player.sendMessage(
          "§cIf you did not receive the book then your inventory is full"
        );
      }
      return true;
    },
  },
  {
    command: "info",
    description: "Gives information about this add-on",
    args: [],
    type: "player",
    action: (player, args) => {
      player.sendMessage(
        "//_____________/ §l§n§gEssentials §r\\_____________\\\\"
      );
      player.sendMessage("§eCreator: §bDead");
      player.sendMessage(
        "§dOffical §9Discord Server: §fhttps://discord.gg/FqwmGcmC7m"
      );
      return true;
    },
  },
  {
    command: "version",
    description: "Shows the version of the add-on",
    args: [],
    type: "player",
    action: (player, args) => {
      player.sendMessage(`Version: ${Version}`);
      return true;
    },
  },
  {
    command: `sell`,
    description: "Use 'sell <amount>' to sell a specific quantity from your hand, or 'sell all' to sell everything.",
    args: ["[all | amount]"],
    type: "player",
    action: (player, args) => {
      if (isPlayerInCreativePlot(player)) {
        player.sendMessage("§cYou cannot sell items while in a creative plot.");
        Bad(player);
        return true;
      }

      let scope = "hand";
      let amount = undefined;

      if (args.length > 1) {
        const firstArg = args[1].toLowerCase();
        if (firstArg === "all") {
          scope = "all";
        } else {
          const parsedAmount = parseInt(firstArg);
          if (!isNaN(parsedAmount) && parsedAmount > 0) {
            amount = parsedAmount;
            scope = "hand";
          } else {
            player.sendMessage("§cInvalid argument. Use 'sell [amount]' or 'sell all'.");
            return false;
          }
        }
      }

      ShopSystem.getInstance().sellPlayerItems(player, scope, amount);
      return true;
    },
  },
  {
    command: "pay",
    description: "Pay another player",
    args: ["[player]", "[amount]"],
    type: "player",
    action: (player, args) => {
      if (args.length < 3) {
        player.sendMessage("§cUsage: !pay [player] [amount]");
        Bad(player);
        return true;
      }
      return handlePayCommand(player, args);
    },
  },
  {
    command: "balance",
    aliases: ["bal"],
    description: "Check your balance",
    args: [],
    type: "player",
    action: (player, args) => {
      checkBalance(player);
      return true;
    },
  },
  {
    command: "withdraw",
    aliases: ["wd"],
    description: "Withdraw money from your account as a physical item",
    args: ["[amount]"],
    type: "player",
    action: (player, args) => {
      handleWithdrawCommand(player, args);
      return true;
    },
  },
  {
    command: "claim",
    description: "Claims the chunk you are standing in, or use start/end to claim a selected area.",
    args: ["[start|end]"],
    type: "player",
    permissionNode: "claims.canClaim",
    action: (player, args) => {
      const subcommand = String(args[1] || "").toLowerCase();
      system.run(() => {
        if (subcommand === "start") {
          startAreaClaimSelection(player);
          return;
        }
        if (subcommand === "end") {
          endAreaClaimSelection(player);
          return;
        }
        claimCurrentChunk(player);
      });
      return true;
    },
  },
  {
    command: "myclaims",
    aliases: ["claims"],
    description: "View your claimed chunks.",
    args: [],
    type: "player",
    action: (player, args) => {
      system.run(() => showMyClaimsMenu(player));
      return true;
    },
  },
  {
    command: "unclaim",
    description: "Unclaims the chunk you are standing in.",
    args: [],
    type: "player",
    action: (player, args) => {
      system.run(() => unclaimCurrentChunk(player));
      return true;
    },
  },
  {
    command: "changelogs",
    aliases: ["changelog", "changes"],
    description: "Opens the Obsidian Essentials changelogs menu.",
    args: [],
    type: "player",
    action: (player) => {
      system.run(() => showChangelogsMenu(player));
      return true;
    },
  },
  {
    command: "party",
    aliases: ["p"],
    description: "Create and manage a party.",
    args: ["[create|invite|accept|deny|chat|bank|info|leave|kick|promote|rename|perms]"],
    type: "player",
    action: (player, args) => {
      system.run(() => handlePartyCommand(player, args));
      return true;
    },
  },
  {
    command: "away",
    description: "Announces that you are AFK",
    args: [],
    type: "player",
    action: (player, args) => {
      setPlayerAFK(player);
      //Good(player);
      return true;
    },
  },
  {
    command: "cplot",
    aliases: ["creativeplot", "creativeplots"],
    description: "Claim and manage a creative plot.",
    args: ["[claim|trust|untrust|info|unclaim]"],
    type: "player",
    action: (player, args) => {
      system.run(() => handleCreativePlotCommand(player, args));
      return true;
    },
  },
  {
    command: "worldborder",
    aliases: ["wb"],
    description: "Create and manage the world border.",
    args: ["[set|get|center]"],
    type: "admin",
    action: (player, args) => {
      return handleWorldBorderCommand(player, args);
    },
  },
  {
    command: "lastseen",
    description: "Check when a player was last seen",
    args: ["[player]"],
    type: "player",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !lastseen [player]");
        Bad(player);
        return true;
      }
      return handleLastSeenCommand(player, args);
    },
  },
  {
    command: "xpget",
    description: "Check a player's XP level (Admin only)",
    args: ["[player]"],
    type: "admin",
    action: (player, args) => {
      if (args.length < 2) {
        player.sendMessage("§cUsage: !xpget [player]");
        Bad(player);
        return true;
      }
      return handleXpGetCommand(player, args);
    },
  },
  {
    command: "nickname",
    aliases: ["nick"],
    description: "Change your display name",
    args: ["[new_name]"],
    type: "perm-based",
    permissionNode: "permissions.canUseNickname",
    action: (player, args) => {
      nickName(player, args);
      return true;
    },
  },
  {
    command: "nickreset",
    description: "Reset a player's nickname to their default name",
    args: ["[player]"],
    type: "admin",
    action: (player, args) => {
      return handleNickResetCommand(player, args);
    },
  },
  {
    command: "nickset",
    description: "Set a player's nickname",
    args: ["[player]", "[nickname]"],
    type: "admin",
    action: (player, args) => {
      return handleNickSetCommand(player, args);
    },
  },
  {
    command: "sudo",
    description: "Impersonate a player and send messages as them",
    args: ["[player]"],
    type: "admin",
    action: (player, args) => {
      return handleSudoCommand(player, args);
    },
  },
  {
    command: "sudoexit",
    description: "Exit sudo impersonation mode",
    args: [],
    type: "admin",
    action: (player, args) => {
      return handleSudoExitCommand(player, args);
    },
  },
  {
    command: "chat",
    description: "Start a private chat with another player",
    args: ["[@player]"],
    type: "player",
    action: (player, args) => {
      return handleChatCommand(player, args);
    },
  },
  {
    command: "endchat",
    description: "End your private chat",
    args: [],
    type: "player",
    action: (player, args) => {
      return handleEndchatCommand(player, args);
    },
  },
  {
    command: "rankcolor",
    aliases: ["rc"],
    description: "Customize the display color of your ranks",
    args: [],
    type: "player",
    action: (player, args) => {
      RankColorUI.showRankSelectionMenu(player);
      return true;
    },
  },
];

setCommandActions(Object.fromEntries(builtInCommands.map(command => [command.command, command.action])));

function playerCanUseCommand(player, commandType, commandName = null, permissionNode = null) {
  // Server owner ALWAYS has access to all commands
  if (isOwner(player)) {
    return true;
  }

  // Check if rank system is disabled
  const rankSystemEnabled = WorldData.get('realm:rankSystemEnabled', true);

  if (!rankSystemEnabled) {
    // If rank system is disabled, use old admin tag system
    switch (commandType) {
      case "admin":
        return hasAdminPermission(player);
      case "dev":
        return PlayerData.get(player, "isDev", false) === true;
      case "vip":
        return PlayerData.get(player, "isVIP", false) === true;
      case "player":
        return true;
      case "perm-based":
        return permissionNode ? permissionManager.hasPermission(player, permissionNode, true) : false;
      default:
        return false;
    }
  }

  // Rank system is enabled, use permission checks
  switch (commandType) {
    case "perm-based":
      // Check if player has the specific permission
      return permissionNode ? permissionManager.hasPermission(player, permissionNode, true) : false;

    case "admin":
      // Check if player has admin command permission
      if (!permissionManager.hasPermission(player, 'moderation.canUseAdminCommands', true)) {
        return false;
      }

      // If commandName is provided, check if it's in the allowed list
      if (commandName) {
        const primaryRank = permissionManager.getPlayerPrimaryRank(player);
        if (primaryRank?.permissions?.moderation?.allowedAdminCommands) {
          const allowedCommands = primaryRank.permissions.moderation.allowedAdminCommands;
          // "*" means all commands are allowed
          if (allowedCommands.includes("*")) {
            return true;
          }
          // Check if this specific command is allowed
          return allowedCommands.includes(commandName);
        }
      }

      return true;

    case "dev":
      return PlayerData.get(player, "isDev", false) === true;

    case "vip":
      return PlayerData.get(player, "isVIP", false) === true;

    case "player":
      if (permissionNode && !permissionManager.hasPermission(player, permissionNode, true)) {
        return false;
      }

      // Check if player has player command permission
      if (!permissionManager.hasPermission(player, 'chat.canUsePlayerCommands', true)) {
        return false;
      }

      // If commandName is provided, check if it's in the allowed list
      if (commandName) {
        const primaryRank = permissionManager.getPlayerPrimaryRank(player);
        if (primaryRank?.permissions?.chat?.allowedPlayerCommands) {
          const allowedCommands = primaryRank.permissions.chat.allowedPlayerCommands;
          // "*" means all commands are allowed
          if (allowedCommands.includes("*")) {
            return true;
          }
          // Empty array means no commands are allowed
          if (allowedCommands.length === 0) {
            return false;
          }
          // Check if this specific command is allowed
          return allowedCommands.includes(commandName);
        }
        // If allowedPlayerCommands is not set, default to allowing all commands
        return true;
      }

      return true;

    default:
      return false;
  }
}

function hasItem(player, ItemTypeId, ItemAmount = 1) {
  let container = player.getComponent("minecraft:inventory").container;
  let Amount = 0;
  for (let i = 0; i < container.size; i++) {
    let containerItem = container.getItem(i);
    if (!containerItem) continue;

    if (containerItem.typeId === ItemTypeId) {
      Amount += containerItem.amount;
    }
  }
  return Amount >= ItemAmount;
}

function displayHelpCommand(player) {
  const c = commandSystemManager.getPrefix();
  const isDev = PlayerData.get(player, "isDev", false);
  const isVIP = PlayerData.get(player, "isVIP", false);
  const isAdmin = hasAdminPermission(player) || isOwner(player);
  const HomesEnabled = WorldData.get("HomesEnabled", false);
  const InfoEnabled = WorldData.get("InfoEnabled", true);
  const KitsEnabled = WorldData.get("Kits_Enabled", false);
  const customCommands = getStoredCommands();

  player.sendMessage(
    "§l§9<<§8----------------------§9<§r §l§n§gEssentials §r §l§9>§8----------------------§9>>§r"
  );
  player.sendMessage(" ");
  player.sendMessage("List Of Active Commands!");
  player.sendMessage(" ");

  if (isAdmin) {
    player.sendMessage("§6Admin commands list has moved to §b" + c + "ah §6or §b" + c + "adminhelp");
    player.sendMessage(" ");
  }

  if (isDev === true) {
    player.sendMessage(
      "//_____________/ §l§5Developer §bCommands§r \\_____________\\\\"
    );
    player.sendMessage(" ");

    builtInCommands
      .filter((cmd) => cmd.type === "dev")
      .forEach((cmd) => {
        const aliases = cmd.aliases
          ? ` §for §b${c}${cmd.aliases.join(` §for §b${c}`)}`
          : "";
        let argsStr = "";
        if (cmd.args && cmd.args.length > 0) {
          argsStr = " " + cmd.args.join(" ");
        }
        player.sendMessage(
          `§b${c}${cmd.command}${argsStr}${aliases} §f- ${cmd.description}`
        );
      });

    player.sendMessage(" ");
  }

  if (isVIP === true) {
    player.sendMessage(
      "//_____________/ §l§3VIP §dCommands§r \\_____________\\\\"
    );
    player.sendMessage(" ");
    player.sendMessage(" ");
  }

  player.sendMessage(
    "§l§9<<§8------------------§9< §r§dPlayer Commands §l§9>§8------------------§9>>§r"
  );
  player.sendMessage(" ");

  // Get player's allowed commands
  const primaryRank = permissionManager.getPlayerPrimaryRank(player);
  const allowedPlayerCommands = primaryRank?.permissions?.chat?.allowedPlayerCommands || ["*"];
  const hasAllPlayerCommands = allowedPlayerCommands.includes("*");

  builtInCommands
    .filter((cmd) => cmd.type === "player")
    .filter((cmd) => hasAllPlayerCommands || allowedPlayerCommands.includes(cmd.command))
    .filter((cmd) => playerCanUseCommand(player, cmd.type, cmd.command, cmd.permissionNode))
    .forEach((cmd) => {
      const aliases = cmd.aliases
        ? ` §for §b${c}${cmd.aliases.join(` §for §b${c}`)}`
        : "";
      let argsStr = "";
      if (cmd.args && cmd.args.length > 0) {
        argsStr = " " + cmd.args.join(" ");
      }
      player.sendMessage(
        `§b${c}${cmd.command}${argsStr}${aliases} §f- ${cmd.description}`
      );
    });

  if (WorldData.get("realm:commissions_pauls_commission", false) === true) {
    player.sendMessage(
      `§b${c}back §f- Allows you to TP back to your death location`
    );
  }
  player.sendMessage(`§b${c}tpa [username] §f- Sends a tpa request`);
  player.sendMessage(
    `§b${c}chat [USER] §f- Lets your private chat other players`
  );
  player.sendMessage(`§b${c}endchat §f- Ends your current private chat`);

  // Permission-based commands section
  const permBasedCmds = builtInCommands
    .filter((cmd) => cmd.type === "perm-based")
    .filter((cmd) => playerCanUseCommand(player, cmd.type, cmd.command, cmd.permissionNode));

  if (permBasedCmds.length > 0) {
    player.sendMessage(" ");
    player.sendMessage(
      "§l§9<<§8------------------§9< §r§ePermission Commands §l§9>§8------------------§9>>§r"
    );
    player.sendMessage(" ");

    permBasedCmds.forEach((cmd) => {
      const aliases = cmd.aliases
        ? ` §for §b${c}${cmd.aliases.join(` §for §b${c}`)}`
        : "";
      let argsStr = "";
      if (cmd.args && cmd.args.length > 0) {
        argsStr = " " + cmd.args.join(" ");
      }
      player.sendMessage(
        `§b${c}${cmd.command}${argsStr}${aliases} §f- ${cmd.description}`
      );
    });
  }

  customCommands.forEach((cmd) => {
    if (cmd.type !== "admin" && canPlayerUseCustomCommand(player, cmd)) {
      player.sendMessage(`§a${c}${cmd.identifier} §f- ${cmd.description}`);
    }
  });
}

function displayAdminHelpCommand(player) {
  const c = commandSystemManager.getPrefix();
  const isDev = PlayerData.get(player, "isDev", false);
  const isOwner_ = isOwner(player);
  const customCommands = getStoredCommands();

  player.sendMessage(
    "§l§9<<§8----------------------§9<§r §l§n§gEssentials §r §l§9>§8----------------------§9>>§r"
  );
  player.sendMessage(" ");
  player.sendMessage("Admin Commands List!");
  player.sendMessage(" ");

  player.sendMessage(
    "§l§9<<§8----------------------§9< §r§cAdmin §l§9>§8----------------------§9>>§r"
  );
  player.sendMessage(" ");

  // Get player's allowed admin commands
  // Server owner always has all admin commands
  let allowedAdminCommands = [];
  let hasAllAdminCommands = isOwner_;

  if (!isOwner_) {
    const primaryRank = permissionManager.getPlayerPrimaryRank(player);
    const modPerms = primaryRank?.permissions?.moderation;
    const rawAllowed = modPerms?.allowedAdminCommands;
    // If canUseAdminCommands is true but allowedAdminCommands is empty/unset, grant all ("*").
    // An empty array is falsy-like in practice but truthy in JS, so we must check .length.
    allowedAdminCommands = (rawAllowed && rawAllowed.length > 0)
        ? rawAllowed
        : (modPerms?.canUseAdminCommands ? ["*"] : []);
    hasAllAdminCommands = allowedAdminCommands.includes("*");
  }

  try {
    builtInCommands
      .filter((cmd) => cmd.type === "admin")
      .filter((cmd) => hasAllAdminCommands || allowedAdminCommands.includes(cmd.command))
      .forEach((cmd) => {
        const aliases = cmd.aliases
          ? ` §for §b${c}${cmd.aliases.join(` §for §b${c}`)}`
          : "";
        let argsStr = "";
        if (cmd.args && cmd.args.length > 0) {
          argsStr = " " + cmd.args.join(" ");
        }
        player.sendMessage(
          `§b${c}${cmd.command}${argsStr}${aliases} §f- ${cmd.description}`
        );
      });
  } catch (err) {
    console.error("[AdminHelp] Error listing commands:", err);
  }

  customCommands.forEach((cmd) => {
    if (cmd.type === "admin" && canPlayerUseCustomCommand(player, cmd)) {
      player.sendMessage(`§a${c}${cmd.identifier} §f- ${cmd.description}`);
    }
  });

  if (isDev === true) {
    player.sendMessage(" ");
    player.sendMessage(
      "//_____________/ §l§5Developer §bCommands§r \\_____________\\\\"
    );
    player.sendMessage(" ");

    builtInCommands
      .filter((cmd) => cmd.type === "dev")
      .forEach((cmd) => {
        const aliases = cmd.aliases
          ? ` §for §b${c}${cmd.aliases.join(` §for §b${c}`)}`
          : "";
        let argsStr = "";
        if (cmd.args && cmd.args.length > 0) {
          argsStr = " " + cmd.args.join(" ");
        }
        player.sendMessage(
          `§b${c}${cmd.command}${argsStr}${aliases} §f- ${cmd.description}`
        );
      });
  }
}

function validateRequiredArgs(player, command, args) {
  if (!command.args || command.args.length === 0) {
    return true;
  }

  const requiredArgCount = command.args.filter(
    (arg) => !arg.startsWith("[") || !arg.endsWith("]")
  ).length;

  if (args.length < requiredArgCount + 1) {
    const cmdPrefix = commandSystemManager.getPrefix();
    const usage = `§cUsage: ${cmdPrefix}${command.command} ${command.args.join(
      " "
    )}`;
    player.sendMessage(usage);
    Bad(player);
    return false;
  }

  return true;
}

export { lastSeenManager };

export function handleCommand(player, commandName, args, mainHandItem) {
  // Check if server has been set up
  if (!hasOwner()) {
    player.sendMessage('§c[SYSTEM] Server must be set up first!');
    player.sendMessage('§eUse §b/scriptevent realm:setup §eto designate the server owner.');
    Bad(player);
    return true;
  }

  const command = builtInCommands.find(
    (cmd) =>
      cmd.command === commandName ||
      (cmd.aliases && cmd.aliases.includes(commandName))
  );

  if (command) {
    if (!playerCanUseCommand(player, command.type, command.command, command.permissionNode)) {
      player.sendMessage(`§cYou do not have permission to use this command!`);
      Bad(player);
      return true;
    }

    return command.action(player, args, mainHandItem);
  }

  return false;
}

// ============================================================================
// AUTO-REGISTER SLASH COMMANDS FROM builtInCommands
// ----------------------------------------------------------------------------
// Every "!" command is also exposed as an "/oe:<name>" slash command, keeping the
// "!" versions intact. Permissions are enforced with the SAME playerCanUseCommand
// gate the "!" path uses, so a command's slash access is tied to exactly the same
// rank/permission/tag rules (not operator status). permissionLevel is Any so that
// non-op players who hold the right rank permission can still run admin/perm-based
// commands; the handler does the real check.
//
// Commands already registered as slash commands elsewhere (slashCommands.js and a
// few hand-written ones below) are skipped to avoid duplicate-registration errors.
// ============================================================================

// Slash names already registered manually elsewhere — skip these in the auto loop.
const MANUALLY_REGISTERED_SLASH = new Set([
  // slashCommands.js
  "help", "book", "info", "balance", "away", "version", "pay", "lastseen",
  "adminhelp", "crate", "vanish", "coinflip", "admintoggle", "removelore",
  "kick", "broadcast", "warn", "addlore",
  // slashCommands.js registers oe:rankcolor; worldborder.js self-registers
  // oe:worldborder (with an enum). Skip both here or they double-register.
  "rankcolor", "worldborder",
  // commandHandler.js (clearchat/menu/party/changelogs registered by hand below)
  "clearchat", "party", "changelogs",
  // enchant's "!" action is a no-op placeholder (handled elsewhere) — don't expose a dead slash command
  "enchant",
]);

function sanitizeSlashName(name) {
  // Custom command names must be [a-z0-9_]; convert hyphens (e.g. save-kit -> save_kit).
  return String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function sanitizeParamName(raw, index, used) {
  let name = String(raw).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (name.length > 24) name = name.slice(0, 24).replace(/_+$/g, "");
  if (!name || !/^[a-z]/.test(name)) name = `arg${index + 1}`;
  while (used.has(name)) name = `${name}_${index + 1}`;
  used.add(name);
  return name;
}

function makeAutoSlashHandler(cmd) {
  return (origin, ...params) => {
    const player = origin?.initiator || origin?.sourceEntity;
    if (!(player instanceof Player)) {
      return { status: CustomCommandStatus.Failure, message: "This command can only be used by players." };
    }

    // Optional params are filled left-to-right; stop at the first missing one.
    const provided = [];
    for (const value of params) {
      if (value === undefined || value === null) break;
      provided.push(String(value));
    }
    const args = [cmd.command, ...provided];

    system.run(() => {
      // Identical permission gate to the "!" command path.
      if (!playerCanUseCommand(player, cmd.type, cmd.command, cmd.permissionNode)) {
        player.sendMessage("§cYou do not have permission to use this command!");
        Bad(player);
        return;
      }

      let mainHandItem;
      try {
        mainHandItem = player.getComponent("inventory")?.container.getItem(player.selectedSlotIndex);
      } catch { }

      try {
        cmd.action(player, args, mainHandItem);
      } catch (e) {
        console.error(`[SlashCommands] Error running auto slash command ${cmd.command}:`, e);
      }
    });

    return { status: CustomCommandStatus.Success };
  };
}

system.beforeEvents.startup.subscribe((init) => {
  const reg = init.customCommandRegistry;
  let registered = 0;
  let errors = 0;

  for (const cmd of builtInCommands) {
    // Dev-only commands are intentionally NOT exposed as slash commands.
    if (cmd.type === "dev") continue;

    const slashName = sanitizeSlashName(cmd.command);
    if (MANUALLY_REGISTERED_SLASH.has(cmd.command) || MANUALLY_REGISTERED_SLASH.has(slashName)) {
      continue;
    }

    try {
      const optionalParameters = [];
      if (Array.isArray(cmd.args) && cmd.args.length > 0) {
        const used = new Set();
        cmd.args.forEach((arg, i) => {
          optionalParameters.push({ type: CustomCommandParamType.String, name: sanitizeParamName(arg, i, used) });
        });
      }

      const def = {
        name: `oe:${slashName}`,
        description: String(cmd.description || cmd.command).slice(0, 100),
        permissionLevel: CommandPermissionLevel.Any,
      };
      if (optionalParameters.length > 0) def.optionalParameters = optionalParameters;

      reg.registerCommand(def, makeAutoSlashHandler(cmd));
      registered++;
    } catch (e) {
      errors++;
      console.error(`[SlashCommands] Failed to auto-register oe:${slashName}:`, e);
    }
  }

  console.warn(`[SlashCommands] Auto-registered ${registered} built-in commands as slash commands (${errors} errors).`);
});

// Chat handling moved to chatHandler.js for consolidation

// Register /clearchat command
system.beforeEvents.startup.subscribe((init) => {
  const clearchatCmd = {
    name: "oe:clearchat",
    description: "Clear your chat",
    permissionLevel: CommandPermissionLevel.Any,
    cheatsRequired: false
  };

  init.customCommandRegistry.registerCommand(clearchatCmd, clearchatHandler);
});

function clearchatHandler(origin) {
  const player = origin?.initiator || origin.sourceEntity;
  if (!(player instanceof Player)) return { status: CustomCommandStatus.Failure, message: "This command is only for players." };

  system.run(() => {
    // Send multiple messages via tellraw to avoid action bar display
    for (let i = 0; i < 100; i++) {
      player.runCommand(`tellraw @s {"rawtext":[{"text":"clearchat-nperma"}]}`);
    }
  });

  system.runTimeout(() => {
    player.sendMessage(`§r§aSuccessfully cleared chat.`);
    player.playSound("random.orb");
  }, 5);

  return { status: CustomCommandStatus.Success };
}

// Import RankUI for permission editing
import { RankUI } from "../handlers/ranksHandler.js";

// Import community panel main menu
import { Main as openCommunityPanel } from "../uis/community_panel/main_menu.js";

// Register /oe:menu command
system.beforeEvents.startup.subscribe((init) => {
  const menuCmd = {
    name: "oe:menu",
    description: "Opens the community panel menu",
    permissionLevel: CommandPermissionLevel.Any,
    cheatsRequired: false
  };

  init.customCommandRegistry.registerCommand(menuCmd, menuCommandHandler);
});

function menuCommandHandler(origin) {
  const player = origin?.initiator || origin.sourceEntity;
  if (!(player instanceof Player)) {
    return { status: CustomCommandStatus.Failure, message: "This command is only for players." };
  }

  system.run(() => {
    openCommunityPanel(player);
  });

  return { status: CustomCommandStatus.Success };
}

system.beforeEvents.startup.subscribe((init) => {
  const partyCmd = {
    name: "oe:party",
    description: "Opens the party menu",
    permissionLevel: CommandPermissionLevel.Any,
    cheatsRequired: false
  };

  init.customCommandRegistry.registerCommand(partyCmd, partyCommandHandler);
});

function partyCommandHandler(origin) {
  const player = origin?.initiator || origin.sourceEntity;
  if (!(player instanceof Player)) {
    return { status: CustomCommandStatus.Failure, message: "This command is only for players." };
  }

  system.run(() => {
    showPartyMenu(player);
  });

  return { status: CustomCommandStatus.Success };
}

system.beforeEvents.startup.subscribe((init) => {
  const changelogsCmd = {
    name: "oe:changelogs",
    description: "Opens the Obsidian Essentials changelogs menu",
    permissionLevel: CommandPermissionLevel.Any,
    cheatsRequired: false
  };

  init.customCommandRegistry.registerCommand(changelogsCmd, changelogsCommandHandler);
});

function changelogsCommandHandler(origin) {
  const player = origin?.initiator || origin.sourceEntity;
  if (!(player instanceof Player)) {
    return { status: CustomCommandStatus.Failure, message: "This command is only for players." };
  }

  system.run(() => {
    showChangelogsMenu(player);
  });

  return { status: CustomCommandStatus.Success };
}

system.beforeEvents.startup.subscribe((init) => {
  const rtpCmd = {
    name: "oe:rtp",
    description: "Randomly teleports you to a safe location.",
    permissionLevel: CommandPermissionLevel.Any,
    cheatsRequired: false
  };

  init.customCommandRegistry.registerCommand(rtpCmd, rtpCommandHandler);
});

function rtpCommandHandler(origin) {
  const player = origin?.initiator || origin.sourceEntity;
  if (!(player instanceof Player)) {
    return { status: CustomCommandStatus.Failure, message: "This command is only for players." };
  }

  system.run(() => {
    handleRTPInstantCommand(player);
  });

  return { status: CustomCommandStatus.Success };
}

// Register /oe:rank command
system.beforeEvents.startup.subscribe((init) => {
  // Register enum for rank actions
  init.customCommandRegistry.registerEnum("oe:rank_action", ["add", "remove", "list", "priority", "create"]);

  const rankCmd = {
    name: "oe:rank",
    description: "Manage player ranks - add, remove, list, or set priority",
    permissionLevel: CommandPermissionLevel.GameDirectors,
    mandatoryParameters: [
      { type: CustomCommandParamType.Enum, name: "oe:rank_action" }
    ],
    optionalParameters: [
      { type: CustomCommandParamType.PlayerSelector, name: "player" },
      { type: CustomCommandParamType.String, name: "rankName" },
      { type: CustomCommandParamType.Integer, name: "priority" }
    ]
  };

  init.customCommandRegistry.registerCommand(rankCmd, rankCommandHandler);
});

function rankCommandHandler(origin, action, targetPlayers, rankName, priority) {
  const player = origin?.initiator || origin.sourceEntity;
  if (!(player instanceof Player)) {
    return { status: CustomCommandStatus.Failure, message: "This command can only be used by players." };
  }

  // Check if player has permission to manage ranks
  if (!permissionManager.hasPermission(player, 'moderation.canUseAdminPanel', true)) {
    // Fallback: also accept admin/Admin tag directly
    if (!player.hasTag('Admin') && !player.hasTag('admin')) {
      return { status: CustomCommandStatus.Failure, message: "§cYou don't have permission to manage ranks." };
    }
  }

  system.run(() => {
    switch (action) {
      case "add":
        handleRankAdd(player, targetPlayers, rankName, priority);
        break;
      case "remove":
        handleRankRemove(player, targetPlayers, rankName);
        break;
      case "list":
        handleRankList(player, targetPlayers);
        break;
      case "priority":
        handleRankPriority(player, targetPlayers, rankName, priority);
        break;
      case "create":
        handleRankCreate(player, rankName, priority);
        break;
      default:
        showRankHelp(player);
    }
  });

  return { status: CustomCommandStatus.Success };
}

function showRankHelp(player) {
  player.sendMessage("§e=== /oe:rank Commands ===");
  player.sendMessage("§b/oe:rank add §f<player> <rankName> [priority]");
  player.sendMessage("  §7Adds a rank to the player (lower priority = shows first)");
  player.sendMessage("§b/oe:rank remove §f<player> <rankName>");
  player.sendMessage("  §7Removes a rank from the player");
  player.sendMessage("§b/oe:rank list §f<player>");
  player.sendMessage("  §7Lists all ranks of the player");
  player.sendMessage("§b/oe:rank priority §f<player> <rankName> <priority>");
  player.sendMessage("  §7Sets the priority of a rank (lower = shows first)");
  player.sendMessage("§b/oe:rank create §f<rankName> [defaultPriority]");
  player.sendMessage("  §7Creates a new permission rank");
}

function handleRankAdd(admin, targetPlayers, rankName, priority) {
  if (!targetPlayers || targetPlayers.length === 0 || !rankName) {
    admin.sendMessage("§cUsage: /oe:rank add <player> <rankName> [priority]");
    admin.sendMessage("§7Example: /oe:rank add @p VIP 1");
    return;
  }

  for (const target of targetPlayers) {
    // Normalize rank name for deduplication
    const rankKey = rankName.toLowerCase().replace(/\s+/g, '_');

    // Build the rank tag with optional priority
    const rankTag = priority !== undefined && priority !== null
      ? `rank:${rankName}:${priority}`
      : `rank:${rankName}`;

    // Remove any existing rank: tags with the same name (prevents duplicates)
    const existingRankTags = target.getTags().filter(t => {
      if (!t.startsWith('rank:')) return false;
      const parts = t.substring(5).split(':');
      return parts[0].toLowerCase() === rankKey;
    });

    for (const oldTag of existingRankTags) {
      target.removeTag(oldTag);
    }

    // Add the new rank tag
    target.addTag(rankTag);

    const priorityText = priority !== undefined ? ` (priority: ${priority})` : '';
    admin.sendMessage(`§aAdded rank '${rankName}'${priorityText} to ${target.name}`);
    target.sendMessage(`§aYou received the rank: ${rankName}${priorityText}`);
  }
}

function handleRankRemove(admin, targetPlayers, rankName) {
  if (!targetPlayers || targetPlayers.length === 0 || !rankName) {
    admin.sendMessage("§cUsage: /oe:rank remove <player> <rankName>");
    return;
  }

  for (const target of targetPlayers) {
    const rankKey = rankName.toLowerCase().replace(/\s+/g, '_');

    // Find and remove all rank: tags matching this name
    const matchingTags = target.getTags().filter(t => {
      if (!t.startsWith('rank:')) return false;
      const parts = t.substring(5).split(':');
      return parts[0].toLowerCase() === rankKey;
    });

    if (matchingTags.length === 0) {
      admin.sendMessage(`§c${target.name} doesn't have the rank '${rankName}'`);
      continue;
    }

    for (const tag of matchingTags) {
      target.removeTag(tag);
    }

    admin.sendMessage(`§aRemoved rank '${rankName}' from ${target.name}`);
    target.sendMessage(`§eYour rank '${rankName}' was removed.`);

    // Validate nickname in case this rank removal affected permissions
    system.run(() => {
      permissionManager.validatePlayerNickname(target);
    });
  }
}

function handleRankList(admin, targetPlayers) {
  if (!targetPlayers || targetPlayers.length === 0) {
    admin.sendMessage("§cUsage: /oe:rank list <player>");
    return;
  }

  for (const target of targetPlayers) {
    // Get all rank: tags
    const rankTags = target.getTags().filter(t =>
      t.startsWith('rank:') ||
      t.startsWith('customrank:') ||
      t.startsWith('glyphrank:')
    );

    admin.sendMessage(`§e=== Ranks for ${target.name} ===`);

    if (rankTags.length === 0) {
      admin.sendMessage("§7No ranks assigned.");
    } else {
      for (const tag of rankTags) {
        admin.sendMessage(`§7- ${tag}`);
      }
    }
  }
}

function handleRankPriority(admin, targetPlayers, rankName, newPriority) {
  if (!targetPlayers || targetPlayers.length === 0 || !rankName || newPriority === undefined) {
    admin.sendMessage("§cUsage: /oe:rank priority <player> <rankName> <priority>");
    admin.sendMessage("§7Lower priority = shows first (1 is highest)");
    return;
  }

  for (const target of targetPlayers) {
    const rankKey = rankName.toLowerCase().replace(/\s+/g, '_');

    // Find existing rank tag matching this name
    const matchingTag = target.getTags().find(t => {
      if (!t.startsWith('rank:')) return false;
      const parts = t.substring(5).split(':');
      return parts[0].toLowerCase() === rankKey;
    });

    if (!matchingTag) {
      admin.sendMessage(`§c${target.name} doesn't have the rank '${rankName}'`);
      continue;
    }

    // Parse old tag and create new one with updated priority
    const oldParts = matchingTag.substring(5).split(':');
    let newTag;

    if (oldParts.length === 1) {
      // Simple: rank:VIP -> rank:VIP:1
      newTag = `rank:${oldParts[0]}:${newPriority}`;
    } else if (oldParts.length === 2) {
      const possiblePriority = parseInt(oldParts[1]);
      if (!isNaN(possiblePriority)) {
        // Text with priority: rank:VIP:1 -> rank:VIP:2
        newTag = `rank:${oldParts[0]}:${newPriority}`;
      } else {
        // Glyph: rank:ADMIN:red -> rank:ADMIN:red:1
        newTag = `rank:${oldParts[0]}:${oldParts[1]}:${newPriority}`;
      }
    } else {
      // Glyph with priority: rank:ADMIN:red:1 -> rank:ADMIN:red:2
      newTag = `rank:${oldParts[0]}:${oldParts[1]}:${newPriority}`;
    }

    target.removeTag(matchingTag);
    target.addTag(newTag);

    admin.sendMessage(`§aUpdated priority for '${rankName}' on ${target.name} to ${newPriority}`);
    target.sendMessage(`§aYour rank '${rankName}' priority is now ${newPriority}`);
  }
}

function handleRankCreate(admin, rankName, hasPermissions) {
  if (!rankName) {
    admin.sendMessage("§cUsage: /oe:rank create <rankName> [hasPermissions]");
    admin.sendMessage("§7Example: /oe:rank create VIP true");
    return;
  }

  const rankId = rankName.toLowerCase().replace(/\s+/g, '_');
  const existingRank = permissionManager.getRank(rankId);
  if (existingRank) {
    admin.sendMessage(`§cRank '${rankName}' already exists.`);
    return;
  }

  const capitalizedName = rankName.charAt(0).toUpperCase() + rankName.slice(1);
  const rankData = {
    rankId: rankId,
    displayName: capitalizedName,
    priority: hasPermissions ? 100 : 1,
    description: `Created via /oe:rank command`,
    isCustomCreated: true,
    isDisplayOnly: !hasPermissions,
    grantPermissions: hasPermissions === true,
    displayTag: `customrank:§f${capitalizedName}`,
    createdBy: admin.name
  };

  const result = permissionManager.createRank(rankData);
  if (result.success) {
    if (hasPermissions) {
      admin.sendMessage(`§aCreated rank '${capitalizedName}' with permissions`);
      admin.sendMessage("§7Opening permission editor...");
      system.runTimeout(() => {
        RankUI.showPermissionEditMenu(admin, result.rank);
      }, 5);
    } else {
      admin.sendMessage(`§aCreated display rank '${capitalizedName}'`);
    }
  } else {
    admin.sendMessage(`§cFailed to create rank: ${result.error}`);
  }
}

// ==================== DEV COMMAND (Only registered if DevBuild is true) ====================

// Dev command registry - add new commands here
const DEV_COMMANDS = {
  help: {
    description: "Show all dev commands",
    usage: "/oe:dev help [category]",
    handler: showDevHelp
  },
  owner: {
    description: "Toggle/check server owner status",
    usage: "/oe:dev owner [true|false]",
    handler: handleDevOwner
  },
  rankdata: {
    description: "Output rank debug data to console",
    usage: "/oe:dev rankdata",
    handler: handleDevRankData
  },
  rankdb: {
    description: "Manage rank database",
    usage: "/oe:dev rankdb [reset]",
    handler: handleDevRankDB
  },
  property: {
    description: "Get/set world dynamic properties",
    usage: "/oe:dev property [name] [value]",
    handler: handleDevProperty
  },
  tags: {
    description: "Manage your tags",
    usage: "/oe:dev tags [clear|add|remove] [tagName]",
    handler: handleDevTags
  },
  scoreboard: {
    description: "Manage scoreboards",
    usage: "/oe:dev scoreboard [list|data|remove] [name]",
    handler: handleDevScoreboard
  },
  storage: {
    description: "View world storage info",
    usage: "/oe:dev storage",
    handler: handleDevStorage
  },
  permission: {
    description: "Check a permission value",
    usage: "/oe:dev permission <permissionPath>",
    handler: handleDevPermission
  },
  reload: {
    description: "Info about reloading scripts",
    usage: "/oe:dev reload",
    handler: handleDevReload
  },
  entity: {
    description: "Entity debug info",
    usage: "/oe:dev entity [kill|count] [type]",
    handler: handleDevEntity
  },
  chatlock: {
    description: "Toggle chat lock",
    usage: "/oe:dev chatlock [true|false]",
    handler: handleDevChatLock
  },
  scripts: {
    description: "Show scriptevent commands reference",
    usage: "/oe:dev scripts",
    handler: handleDevScripts
  }
};

if (DevBuild) {
  system.beforeEvents.startup.subscribe((init) => {
    // Register enum for dev actions dynamically from DEV_COMMANDS
    const actions = Object.keys(DEV_COMMANDS);
    init.customCommandRegistry.registerEnum("oe:dev_action", actions);

    const devCmd = {
      name: "oe:dev",
      description: "[DEV] Developer tools and debugging commands",
      permissionLevel: CommandPermissionLevel.Admin,
      mandatoryParameters: [
        { type: CustomCommandParamType.Enum, name: "oe:dev_action" }
      ],
      optionalParameters: [
        { type: CustomCommandParamType.String, name: "arg1" },
        { type: CustomCommandParamType.String, name: "arg2" },
        { type: CustomCommandParamType.String, name: "arg3" }
      ]
    };

    init.customCommandRegistry.registerCommand(devCmd, devCommandHandler);
  });
}

function devCommandHandler(origin, action, arg1, arg2, arg3) {
  const player = origin?.initiator || origin.sourceEntity;
  if (!(player instanceof Player)) {
    return { status: CustomCommandStatus.Failure, message: "This command can only be used by players." };
  }

  const cmd = DEV_COMMANDS[action];
  if (!cmd) {
    system.run(() => showDevHelp(player));
    return { status: CustomCommandStatus.Success };
  }

  system.run(() => {
    try {
      cmd.handler(player, arg1, arg2, arg3);
    } catch (error) {
      player.sendMessage(`§cError: ${error.message || error}`);
      console.error(`[Dev Command Error] ${action}:`, error);
    }
  });

  return { status: CustomCommandStatus.Success };
}

function showDevHelp(player, category) {
  player.sendMessage("§e§l=== /oe:dev Commands ===");
  player.sendMessage("§7Developer tools (DevBuild only)\n");

  for (const [name, cmd] of Object.entries(DEV_COMMANDS)) {
    player.sendMessage(`§b${cmd.usage}`);
    player.sendMessage(`  §7${cmd.description}`);
  }

  player.sendMessage("\n§e§l=== Scriptevent Commands ===");
  player.sendMessage("§7Use §f/oe:dev scripts §7for full list");
}

function handleDevOwner(player, arg) {
  if (!arg || arg === "info") {
    const owner = getOwner();
    const isPlayerOwner = isOwner(player);

    player.sendMessage("§e=== Owner Status ===");
    if (owner) {
      player.sendMessage(`§7Owner ID: §f${owner.displayName}`);
    } else {
      player.sendMessage("§7No owner is currently set.");
    }
    player.sendMessage(`§7You are: ${isPlayerOwner ? '§athe owner' : '§cnot the owner'}`);
    return;
  }

  if (arg === "true") {
    if (isOwner(player)) {
      player.sendMessage("§eYou are already the owner!");
      return;
    }
    if (setOwner(player)) {
      player.sendMessage("§a✓ You are now the server owner!");
    } else {
      player.sendMessage("§cFailed to set owner.");
    }
  } else if (arg === "false") {
    if (!isOwner(player)) {
      player.sendMessage("§eYou are not the owner.");
      return;
    }
    if (removeOwner(player)) {
      player.sendMessage("§a✓ Owner status removed.");
    } else {
      player.sendMessage("§cFailed to remove owner status.");
    }
  }
}

function handleDevRankData(player) {
  console.warn("=== RANK DEBUG DATA ===");

  const ownerStatus = isOwner(player);
  const hasDevTag = player.hasTag('dev');
  const hasAdminTag = player.hasTag('Admin') || player.hasTag('admin');
  console.warn(`[Owner Status]: ${ownerStatus}`);
  console.warn(`[Has 'dev' Tag]: ${hasDevTag}`);
  console.warn(`[Has 'Admin'/'admin' Tag]: ${hasAdminTag}`);
  console.warn(`[Bypasses Permission Check]: ${ownerStatus}`);

  const allRanks = permissionManager.getRanks();
  console.warn("[All Ranks]:", JSON.stringify(allRanks, null, 2));

  const playerRankIds = permissionManager.getPlayerRanks(player);
  console.warn(`[Player ${player.name} Rank IDs]:`, JSON.stringify(playerRankIds));

  const primaryRank = permissionManager.getPlayerPrimaryRank(player);
  console.warn(`[Player ${player.name} Primary Rank]:`, JSON.stringify(primaryRank, null, 2));

  const defaultRank = permissionManager.getRank("default");
  console.warn("[Default Rank]:", JSON.stringify(defaultRank, null, 2));

  const tags = player.getTags();
  console.warn(`[Player ${player.name} ALL Tags]:`, JSON.stringify(tags));

  const canUseAdminPanel = permissionManager.hasPermission(player, 'moderation.canUseAdminPanel', true);
  console.warn(`[Permission 'moderation.canUseAdminPanel']: ${canUseAdminPanel}`);

  console.warn("=== END RANK DEBUG DATA ===");
  player.sendMessage("§aRank debug data output to console.");
}

function handleDevRankDB(player, arg) {
  if (arg === "reset") {
    try {
      const SCOREBOARD_PREFIX = "ds_oe:permissions_";
      const objectives = world.scoreboard.getObjectives();
      let cleared = 0;

      for (const objective of objectives) {
        if (objective.id.startsWith(SCOREBOARD_PREFIX)) {
          world.scoreboard.removeObjective(objective);
          cleared++;
        }
      }

      WorldData.set('realm:permissions_migrated_v3', undefined);
      player.sendMessage(`§a✓ Rank database reset! Cleared ${cleared} objectives.`);
      player.sendMessage("§7Rejoin to reinitialize default ranks.");
    } catch (error) {
      player.sendMessage(`§cFailed: ${error}`);
    }
  } else {
    player.sendMessage("§e=== Rank Database ===");
    player.sendMessage("§7Use: §f/oe:dev rankdb reset");
    player.sendMessage("§c⚠ Warning: Deletes all ranks!");
  }
}

function handleDevProperty(player, propName, propValue) {
  if (!propName) {
    const propIds = world.getDynamicPropertyIds();
    player.sendMessage(`§e=== World Properties (${propIds.length}) ===`);
    for (const id of propIds.slice(0, 15)) {
      const value = world.getDynamicProperty(id);
      const display = typeof value === 'string' && value.length > 30
        ? value.substring(0, 30) + '...'
        : JSON.stringify(value);
      player.sendMessage(`§7${id}: §f${display}`);
    }
    if (propIds.length > 15) {
      player.sendMessage(`§7... and ${propIds.length - 15} more`);
    }
    return;
  }

  if (!propValue) {
    const value = world.getDynamicProperty(propName);
    player.sendMessage(`§7${propName}: §f${JSON.stringify(value)}`);
  } else {
    let valueToSet;
    if (propValue === "true") valueToSet = true;
    else if (propValue === "false") valueToSet = false;
    else if (propValue === "null" || propValue === "undefined") valueToSet = undefined;
    else if (!isNaN(Number(propValue))) valueToSet = Number(propValue);
    else valueToSet = propValue;

    if (valueToSet === undefined) {
      world.setDynamicProperty(propName, undefined);
      player.sendMessage(`§a✓ Cleared: ${propName}`);
    } else {
      world.setDynamicProperty(propName, valueToSet);
      player.sendMessage(`§a✓ Set ${propName} = ${JSON.stringify(valueToSet)}`);
    }
  }
}

function handleDevTags(player, action, tagName) {
  if (action === "clear") {
    const tags = player.getTags();
    for (const tag of tags) {
      player.removeTag(tag);
    }
    player.sendMessage(`§a✓ Cleared ${tags.length} tags.`);
    return;
  }

  if (action === "add" && tagName) {
    player.addTag(tagName);
    player.sendMessage(`§a✓ Added tag: ${tagName}`);
    return;
  }

  if (action === "remove" && tagName) {
    if (player.hasTag(tagName)) {
      player.removeTag(tagName);
      player.sendMessage(`§a✓ Removed tag: ${tagName}`);
    } else {
      player.sendMessage(`§cYou don't have tag: ${tagName}`);
    }
    return;
  }

  const tags = player.getTags();
  player.sendMessage(`§e=== Your Tags (${tags.length}) ===`);
  if (tags.length === 0) {
    player.sendMessage("§7No tags.");
  } else {
    player.sendMessage(`§7${tags.join(', ')}`);
  }
}

function handleDevScoreboard(player, action, name) {
  const objectives = world.scoreboard.getObjectives();

  if (action === "list" || !action) {
    player.sendMessage(`§e=== Scoreboards (${objectives.length}) ===`);
    for (const obj of objectives.slice(0, 20)) {
      const participants = obj.getParticipants().length;
      player.sendMessage(`§7${obj.id} §8(${participants} entries)`);
    }
    if (objectives.length > 20) {
      player.sendMessage(`§7... and ${objectives.length - 20} more`);
    }
    return;
  }

  if (action === "data" && name) {
    const obj = world.scoreboard.getObjective(name);
    if (!obj) {
      player.sendMessage(`§cScoreboard '${name}' not found.`);
      return;
    }
    const participants = obj.getParticipants();
    player.sendMessage(`§e=== ${name} (${participants.length} entries) ===`);
    for (const p of participants.slice(0, 10)) {
      const score = obj.getScore(p);
      player.sendMessage(`§7${p.displayName}: §f${score}`);
    }
    console.warn(`[Scoreboard ${name}]`, JSON.stringify(participants.map(p => ({
      name: p.displayName,
      score: obj.getScore(p)
    })), null, 2));
    player.sendMessage("§7Full data output to console.");
    return;
  }

  if (action === "remove" && name) {
    const obj = world.scoreboard.getObjective(name);
    if (!obj) {
      player.sendMessage(`§cScoreboard '${name}' not found.`);
      return;
    }
    world.scoreboard.removeObjective(obj);
    player.sendMessage(`§a✓ Removed scoreboard: ${name}`);
    return;
  }

  player.sendMessage("§7Usage: /oe:dev scoreboard [list|data|remove] [name]");
}

function handleDevStorage(player) {
  const propIds = world.getDynamicPropertyIds();
  const totalBytes = world.getDynamicPropertyTotalByteCount();
  const objectives = world.scoreboard.getObjectives();

  player.sendMessage("§e=== World Storage ===");
  player.sendMessage(`§7Dynamic Properties: §f${propIds.length}`);
  player.sendMessage(`§7Property Bytes Used: §f${totalBytes.toLocaleString()} / 10,485,760`);
  player.sendMessage(`§7Scoreboards: §f${objectives.length}`);

  let totalParticipants = 0;
  for (const obj of objectives) {
    totalParticipants += obj.getParticipants().length;
  }
  player.sendMessage(`§7Total Scoreboard Entries: §f${totalParticipants.toLocaleString()}`);
}

function handleDevPermission(player, permPath) {
  if (!permPath) {
    player.sendMessage("§7Usage: /oe:dev permission <path>");
    player.sendMessage("§7Example: /oe:dev permission moderation.canUseAdminPanel");
    player.sendMessage("§7Example: /oe:dev permission homes.maxHomes");
    return;
  }

  const hasIt = permissionManager.hasPermission(player, permPath, true);
  const value = permissionManager.getPermissionValue(player, permPath);

  player.sendMessage(`§e=== Permission: ${permPath} ===`);
  player.sendMessage(`§7Has Permission (true): §f${hasIt}`);
  player.sendMessage(`§7Value: §f${JSON.stringify(value)}`);
}

function handleDevReload(player) {
  player.sendMessage("§e=== Script Reload Info ===");
  player.sendMessage("§7To reload scripts:");
  player.sendMessage("§f/reload §7- Soft reload (may not update commands)");
  player.sendMessage("§7Leave and rejoin world for full reload");
  player.sendMessage("§c⚠ Custom command params can't change on soft reload");
}

function handleDevEntity(player, action, entityType) {
  if (action === "count") {
    const entities = player.dimension.getEntities();
    const counts = {};
    for (const e of entities) {
      counts[e.typeId] = (counts[e.typeId] || 0) + 1;
    }

    player.sendMessage(`§e=== Entities (${entities.length}) ===`);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted.slice(0, 15)) {
      player.sendMessage(`§7${type}: §f${count}`);
    }
    return;
  }

  if (action === "kill" && entityType) {
    const entities = player.dimension.getEntities({ type: entityType });
    let killed = 0;
    for (const e of entities) {
      try {
        e.kill();
        killed++;
      } catch { }
    }
    player.sendMessage(`§a✓ Killed ${killed} ${entityType}`);
    return;
  }

  player.sendMessage("§7Usage: /oe:dev entity [count|kill] [type]");
  player.sendMessage("§7Example: /oe:dev entity count");
  player.sendMessage("§7Example: /oe:dev entity kill minecraft:zombie");
}

function handleDevChatLock(player, arg) {
  const current = world.getDynamicProperty('realm:ChatLock') ?? false;

  if (!arg) {
    player.sendMessage(`§7Chat Lock: ${current ? '§cENABLED' : '§aDISABLED'}`);
    return;
  }

  const newState = arg === "true";
  world.setDynamicProperty('realm:ChatLock', newState);
  player.sendMessage(`§a✓ Chat Lock: ${newState ? '§cENABLED' : '§aDISABLED'}`);
}

function handleDevScripts(player) {
  player.sendMessage("§e§l=== Scriptevent Commands ===\n");

  player.sendMessage("§6[Setup & Admin]");
  player.sendMessage("§f/scriptevent realm:setup §7- Set server owner");
  player.sendMessage("§f/scriptevent realm:ranks §7- Open rank management");
  player.sendMessage("§f/scriptevent realm:permissions §7- Permission menu");
  player.sendMessage("§f/scriptevent realm:rankdb.reset §7- Reset rank DB");

  player.sendMessage("\n§6[Dev Tools]");
  player.sendMessage("§f/scriptevent realm:dev §7- Dev menu");
  player.sendMessage("§f/scriptevent realm:storage §7- Storage info");
  player.sendMessage("§f/scriptevent realm:dev.scoreboard.data <name>");

  player.sendMessage("\n§6[Systems]");
  player.sendMessage("§f/scriptevent realm:mobcash §7- MobCash menu");
  player.sendMessage("§f/scriptevent realm:polls §7- Polls menu");
  player.sendMessage("§f/scriptevent realm:dailyrewards claim");
  player.sendMessage("§f/scriptevent realm:commission §7- Commission menu");

  player.sendMessage("\n§6[Warps]");
  player.sendMessage("§f/scriptevent realm:dev.warps create:<name>");
  player.sendMessage("§f/scriptevent realm:dev.warps tp:<name>");
  player.sendMessage("§f/scriptevent realm:dev.warps delete:<name>");
  player.sendMessage("§f/scriptevent realm:dev.warps list");

  player.sendMessage("\n§7Use §f/oe:dev help §7for /oe:dev commands");
}
