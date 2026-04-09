console.log("🚀 Script deploy-commands.js lancé !");
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const TOKEN = "MTQ0ODQxNDQ5Njg3MDYzMzQ4Ng.GM3hV_.mqG9QrEwymhpybcrYVRevqjj6XkEeepU9RftCk";
const CLIENT_ID = "1448414496870633486";
const GUILD_ID = "1447883128827019266";

const commands = [
  new SlashCommandBuilder()
    .setName("rdv")
    .setDescription("Ouvrir le formulaire RDV"),

  new SlashCommandBuilder()
    .setName("modifier-rdv")
    .setDescription("Modifier un RDV existant par son ID (statut, date, heure)"),

].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("⏳ Enregistrement des commandes...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commandes /rdv et /modifier-rdv enregistrées !");
  } catch (error) {
    console.error(error);
  }
})();
