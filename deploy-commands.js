console.log("🚀 Script deploy-commands.js lancé !");

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

// Mets ici ton token, ton client ID et ton guild ID
const TOKEN = "MTQ0ODQxNDQ5Njg3MDYzMzQ4Ng.GM3hV_.mqG9QrEwymhpybcrYVRevqjj6XkEeepU9RftCk";
const CLIENT_ID = "1448414496870633486"; // Developer Portal → Application → General Information
const GUILD_ID = "1447883128827019266";   // Clique droit sur ton serveur Discord → Copier l’ID

const commands = [
  new SlashCommandBuilder()
    .setName("rdv")
    .setDescription("Ouvrir le formulaire RDV")
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("⏳ Enregistrement de la commande /rdv...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commande /rdv enregistrée !");
  } catch (error) {
    console.error(error);
  }
})();
