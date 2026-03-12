require("dotenv").config();
const { SlashCommandBuilder, REST, Routes } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("rdv")
    .setDescription("Créer un RDV en 2 étapes")
    .toJSON()
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("🚀 Déploiement des commandes slash...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commande /rdv déployée !");
  } catch (error) {
    console.error(error);
  }
})();
