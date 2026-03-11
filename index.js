require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const cron = require('node-cron');
const { getSheetData, updateCell } = require('./googleService');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Colonnes du Google Sheet (index 0)
const COL = {
  HORODATEUR: 0,   // A
  AGENT: 1,        // B
  GARAGE: 2,       // C
  CLIENT: 3,       // D
  VEHICULE: 4,     // E
  TEL: 5,          // F
  DATE_RDV: 6,     // G
  HEURE_RDV: 7,    // H
  REBOOKE: 8,      // I
  STATUT: 9,       // J
};

// Mémoire des NO SHOW en cours de traitement
// clé = "rowIndex", valeur = { agentNom, assignedTo, claimedAt, reminderDate, discordMessageId }
const noShowTracker = {};

// ─── UTILITAIRES ────────────────────────────────────────────────

function parseDate(dateStr, heureStr) {
  // Format attendu : DD/MM/YYYY et HH:MM:SS
  if (!dateStr) return null;
  try {
    const [day, month, year] = dateStr.trim().split('/');
    const [hour, min] = (heureStr || '00:00').trim().split(':');
    return new Date(year, month - 1, day, hour, min, 0);
  } catch {
    return null;
  }
}

function hoursElapsed(date) {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

function buildNoShowEmbed(row, rowIndex, status = 'open') {
  const statusText = {
    open: '🚨 NON TRAITÉ — Disponible',
    claimed: '🙋 En cours de traitement',
    reminder: '⏰ Rappel programmé',
  }[status] || '🚨 NON TRAITÉ';

  return new EmbedBuilder()
    .setColor(status === 'open' ? 0xff0000 : status === 'claimed' ? 0xffa500 : 0x3498db)
    .setTitle('🔴 NO SHOW — Rappel client requis')
    .addFields(
      { name: '👤 Client', value: row[COL.CLIENT] || 'Inconnu', inline: true },
      { name: '📞 Téléphone', value: row[COL.TEL] || 'N/A', inline: true },
      { name: '👷 Agent', value: row[COL.AGENT] || 'N/A', inline: true },
      { name: '📅 Date RDV', value: row[COL.DATE_RDV] || 'N/A', inline: true },
      { name: '🕐 Heure RDV', value: row[COL.HEURE_RDV] || 'N/A', inline: true },
      { name: '🏢 Garage', value: row[COL.GARAGE] || 'N/A', inline: true },
      { name: '🚗 Véhicule', value: row[COL.VEHICULE] || 'N/A', inline: true },
      { name: '📊 Statut', value: statusText, inline: false },
    )
    .setFooter({ text: `Ligne Sheet: ${rowIndex + 1}` })
    .setTimestamp();
}

function buildButtons(rowIndex, phase = 'open') {
  const row = new ActionRowBuilder();

  if (phase === 'open') {
    // Pas encore réclamé → tout le monde peut prendre
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`je_suis_dessus_${rowIndex}`)
        .setLabel('🙋 Je suis dessus')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`je_le_prends_${rowIndex}`)
        .setLabel('👋 Je le prends')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`rdv_repris_${rowIndex}`)
        .setLabel('✅ RDV Repris')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`abandonner_${rowIndex}`)
        .setLabel('❌ Abandonner')
        .setStyle(ButtonStyle.Danger),
    );
  } else if (phase === 'claimed') {
    // Déjà réclamé → plus de "Je le prends"
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`je_suis_dessus_${rowIndex}`)
        .setLabel('🙋 Toujours dessus +24h')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`rdv_repris_${rowIndex}`)
        .setLabel('✅ RDV Repris')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rappel_programme_${rowIndex}`)
        .setLabel('📅 Rappel programmé')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`abandonner_${rowIndex}`)
        .setLabel('❌ Abandonner')
        .setStyle(ButtonStyle.Danger),
    );
  }

  return row;
}

// ─── DÉTECTION DES NO SHOW ───────────────────────────────────────

async function checkNoShows() {
  try {
    const rows = await getSheetData();
    const channel = await client.channels.fetch(process.env.NOSHOW_CHANNEL_ID);
    if (!channel) return;

    const now = new Date();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 10) continue;

      const statut = (row[COL.STATUT] || '').trim().toUpperCase();
      const rebooke = (row[COL.REBOOKE] || '').trim().toUpperCase();

      // On ne traite que les NO SHOW
      if (statut !== 'NO SHOW') continue;

      // Si déjà rebooké ou VENU ou ANNULÉ → on ignore
      if (rebooke === 'OUI' || statut === 'VENU' || statut === 'ANNULÉ') continue;

      const rdvDate = parseDate(row[COL.DATE_RDV], row[COL.HEURE_RDV]);
      if (!rdvDate) continue;

      const heuresEcoulees = hoursElapsed(rdvDate);
      const tracker = noShowTracker[i];

      // ─ Déjà envoyé dans Discord ?
      if (tracker) {
        // Vérifier si 48h de grâce + 5 jours dépassés depuis le RDV → forcer ouverture aux autres
        if (heuresEcoulees > (48 + 5 * 24)) {
          if (tracker.assignedTo) {
            try {
              const msg = await channel.messages.fetch(tracker.discordMessageId);
              const embed = buildNoShowEmbed(row, i, 'open');
              embed.addFields({ name: '⚠️ Délai 5 jours dépassé', value: 'Ouvert à toute l\'équipe !', inline: false });
              await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
              await channel.send(`@everyone ⚠️ Le NO SHOW de **${row[COL.CLIENT]}** n'a pas été réglé en 5 jours — quelqu'un peut le prendre !`);
            } catch {}
            tracker.assignedTo = null;
          }
        }

        // Vérifier si personne n'a la main et 12h écoulées depuis la dernière relance → @everyone
        if (!tracker.assignedTo && !tracker.reminderDate && tracker.lastRelance) {
          const heuresDepuisRelance = hoursElapsed(tracker.lastRelance);
          if (heuresDepuisRelance >= 12) {
            try {
              await channel.send(`@everyone 🔁 Rappel — **${row[COL.CLIENT]}** (${row[COL.GARAGE]}) n'a toujours pas été pris en charge ! Quelqu'un peut le traiter ?`);
            } catch {}
            tracker.lastRelance = new Date();
          }
        }

        // Vérifier si 24h écoulées depuis le dernier "Je suis dessus" → notifier l'agent
        if (tracker.assignedTo && tracker.claimedAt) {
          const heuresDepuisClaim = hoursElapsed(tracker.claimedAt);
          if (heuresDepuisClaim >= 24) {
            const joursRestants = 5 - (tracker.jesuisCount || 0);

            if (joursRestants > 0) {
              // Notifier l'agent en DM pour qu'il reclique "Je suis dessus"
              try {
                const membres = await channel.guild.members.fetch();
                const agentMembre = membres.find(m =>
                  m.user.username.toLowerCase() === tracker.assignedTo.toLowerCase()
                );
                if (agentMembre) {
                  await agentMembre.send(
                    `⏰ **Rappel NO SHOW — ${row[COL.CLIENT]}** (${row[COL.GARAGE]})
` +
                    `Tes 24h sont écoulées ! Tu as encore **${joursRestants} jour(s)** pour traiter ce NO SHOW.
` +
                    `👉 Va dans #no-show-équipe et reclique **"🙋 Je suis dessus"** pour garder la main !`
                  );
                }
              } catch {}

              // Remettre la fiche en "open" pour que l'équipe voit que c'est relancé
              try {
                const msg = await channel.messages.fetch(tracker.discordMessageId);
                const embed = buildNoShowEmbed(row, i, 'open');
                embed.addFields({
                  name: '🔔 Relance',
                  value: `**${tracker.assignedTo}** — 24h écoulées, reclique "Je suis dessus" ou un autre agent peut prendre !`,
                  inline: false,
                });
                await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
              } catch {}

              tracker.assignedTo = null;
              tracker.claimedAt = null;

            } else {
              // 5 jours épuisés → forcer ouverture à toute l'équipe
              try {
                const msg = await channel.messages.fetch(tracker.discordMessageId);
                const embed = buildNoShowEmbed(row, i, 'open');
                embed.addFields({
                  name: '🚨 5 jours épuisés',
                  value: `Ce NO SHOW est maintenant ouvert à toute l'équipe !`,
                  inline: false,
                });
                await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
                await channel.send(`@everyone 🚨 **${row[COL.CLIENT]}** (${row[COL.GARAGE]}) — 5 jours épuisés, quelqu'un prend ?`);
              } catch {}
              tracker.assignedTo = null;
              tracker.claimedAt = null;
            }
          }
        }

        // Vérifier si rappel programmé est arrivé
        if (tracker.reminderDate && now >= tracker.reminderDate) {
          const heuresDepuisRappel = hoursElapsed(tracker.reminderDate);

          if (heuresDepuisRappel < 24) {
            // Moins de 24h depuis la date de rappel → on notifie l'agent mais on ne relance pas encore
            if (!tracker.reminderNotified) {
              try {
                const msg = await channel.messages.fetch(tracker.discordMessageId);
                const embed = buildNoShowEmbed(row, i, 'claimed');
                embed.addFields({
                  name: '⏰ Rappel programmé atteint',
                  value: `**${tracker.assignedTo || 'Agent'}** — c'est le moment de rappeler **${row[COL.CLIENT]}** ! Tu as 24h avant que ça s'ouvre à l'équipe.`,
                  inline: false,
                });
                await msg.edit({ embeds: [embed], components: [buildButtons(i, 'claimed')] });
              } catch {}
              tracker.reminderNotified = true;
            }
          } else {
            // 24h écoulées depuis la date de rappel → on relance à toute l'équipe
            try {
              const msg = await channel.messages.fetch(tracker.discordMessageId);
              const embed = buildNoShowEmbed(row, i, 'open');
              embed.addFields({
                name: '🚨 Rappel non traité',
                value: `24h écoulées depuis la date de rappel pour **${row[COL.CLIENT]}** — ouvert à toute l'équipe !`,
                inline: false,
              });
              await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
              await channel.send(`@everyone 🔔 Rappel non traité pour **${row[COL.CLIENT]}** (${row[COL.GARAGE]}) — quelqu'un peut le prendre !`);
            } catch {}
            tracker.reminderDate = null;
            tracker.reminderNotified = false;
            tracker.assignedTo = null;
          }
        }

        continue; // Déjà dans Discord, on ne renvoie pas
      }

      // ─ Pas encore envoyé : attendre 48h après le RDV
      // (24h pour que le garage qualifie + 24h pour que l'agent rappelle)
      if (heuresEcoulees < 48) continue;

      // ─ Vérifier si le client a déjà un nouveau RDV dans le Sheet
      // On vérifie 3 critères : même client + même garage + même véhicule
      // (un même nom peut apparaître dans 30 garages différents,
      //  et un client peut avoir plusieurs véhicules)
      const nomClient    = (row[COL.CLIENT]   || '').trim().toLowerCase();
      const garageClient = (row[COL.GARAGE]   || '').trim().toLowerCase();
      const vehiculeClient = (row[COL.VEHICULE] || '').trim().toLowerCase();

      const dejaRepositionne = rows.some((autreRow, autreIndex) => {
        if (autreIndex === i || autreIndex === 0) return false;
        const autreNom      = (autreRow[COL.CLIENT]   || '').trim().toLowerCase();
        const autreGarage   = (autreRow[COL.GARAGE]   || '').trim().toLowerCase();
        const autreVehicule = (autreRow[COL.VEHICULE] || '').trim().toLowerCase();
        const autreStatut   = (autreRow[COL.STATUT]   || '').trim().toUpperCase();
        const autreDate     = parseDate(autreRow[COL.DATE_RDV], autreRow[COL.HEURE_RDV]);

        // Correspondance souple sur le véhicule :
        // on vérifie si l'un contient l'autre (ex: "Renault" ⊂ "Renault 2008")
        const vehiculeMatch =
          autreVehicule.includes(vehiculeClient) ||
          vehiculeClient.includes(autreVehicule) ||
          autreVehicule === vehiculeClient;

        return (
          autreNom    === nomClient    &&  // même client (exact)
          autreGarage === garageClient &&  // même garage (ex: VROOM REIMS)
          vehiculeMatch                && // même véhicule (souple)
          autreDate   && autreDate > now && // RDV dans le futur
          autreStatut !== 'NO SHOW'         // pas un autre NO SHOW
        );
      });

      if (dejaRepositionne) {
        console.log(`⏭️ NO SHOW ligne ${i + 1} ignoré — ${row[COL.CLIENT]} (${row[COL.GARAGE]} / ${row[COL.VEHICULE]}) a déjà un nouveau RDV`);
        continue;
      }

      // Envoyer dans Discord
      const embed = buildNoShowEmbed(row, i, 'open');
      const buttons = buildButtons(i, 'open');

      const msg = await channel.send({
        content: `@everyone 🚨 NO SHOW non traité depuis plus de 48h !`,
        embeds: [embed],
        components: [buttons],
      });

      noShowTracker[i] = {
        agentNom: row[COL.AGENT],
        assignedTo: null,
        claimedAt: null,
        reminderDate: null,
        reminderNotified: false,
        discordMessageId: msg.id,
        lastRelance: new Date(),
        jesuisCount: 0, // compteur de clics "Je suis dessus"
      };

      // Notifier l'agent original en DM pour qu'il prenne la main en priorité
      try {
        const membres = await channel.guild.members.fetch();
        const agentMembre = membres.find(m =>
          m.user.username.toLowerCase().includes((row[COL.AGENT] || '').toLowerCase().split(' ')[0])
        );
        if (agentMembre) {
          await agentMembre.send(
            `🚨 **NO SHOW — Action requise !**
` +
            `Ton RDV avec **${row[COL.CLIENT]}** (${row[COL.GARAGE]}) est non venu.
` +
            `Va dans #no-show-équipe et clique **"🙋 Je suis dessus"** pour garder la main !
` +
            `Tu as **5 jours** pour le traiter.`
          );
        }
      } catch (dmErr) {
        console.log(`⚠️ Impossible d'envoyer un DM à l'agent ${row[COL.AGENT]}`);
      }

      console.log(`✅ NO SHOW envoyé pour ligne ${i + 1} : ${row[COL.CLIENT]}`);
    }
  } catch (err) {
    console.error('Erreur checkNoShows:', err);
  }
}

// ─── GESTION DES BOUTONS ─────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {

  // ── BOUTONS ──
  if (interaction.isButton()) {
    const [action, , rowIndexStr] = interaction.customId.split('_');
    const rowIndex = parseInt(rowIndexStr || interaction.customId.split('_').pop());
    const tracker = noShowTracker[rowIndex];
    const rows = await getSheetData();
    const row = rows[rowIndex];

    if (!row) {
      await interaction.reply({ content: '❌ Ligne introuvable.', ephemeral: true });
      return;
    }

    const agentNom = interaction.user.username;

    // ── JE SUIS DESSUS ──
    if (interaction.customId.startsWith('je_suis_dessus_')) {
      // Maximum = 48h de grâce + 5 jours = 7 jours depuis le RDV
      const rdvDateCheck = parseDate(row[COL.DATE_RDV], row[COL.HEURE_RDV]);
      if (rdvDateCheck && hoursElapsed(rdvDateCheck) > (48 + 5 * 24)) {
        await interaction.reply({
          content: `❌ Délai maximum dépassé (48h de grâce + 5 jours). Ce NO SHOW est maintenant ouvert à toute l'équipe.`,
          ephemeral: true,
        });
        return;
      }

      if (tracker) {
        tracker.assignedTo = agentNom;
        tracker.claimedAt = new Date(); // Remet le compteur 24h à zéro
        tracker.jesuisCount = (tracker.jesuisCount || 0) + 1;
      }

      const embed = buildNoShowEmbed(row, rowIndex, 'claimed');
      embed.addFields(
        { name: '🙋 Pris en charge par', value: agentNom, inline: true },
        { name: '⏰ Prochaine relance', value: 'Dans 24h si pas de résultat', inline: true },
      );

      await interaction.update({
        embeds: [embed],
        components: [buildButtons(rowIndex, 'claimed')],
      });

      console.log(`🙋 ${agentNom} est sur le NO SHOW ligne ${rowIndex + 1} — silence 24h`);
      return;
    }

    // ── JE LE PRENDS ──
    if (interaction.customId.startsWith('je_le_prends_')) {
      // Vérifier que personne n'a déjà la main
      if (tracker && tracker.assignedTo) {
        await interaction.reply({
          content: `❌ Ce NO SHOW est déjà pris en charge par **${tracker.assignedTo}** !`,
          ephemeral: true,
        });
        return;
      }

      if (tracker) {
        tracker.assignedTo = agentNom;
        tracker.claimedAt = new Date();
      }

      const embed = buildNoShowEmbed(row, rowIndex, 'claimed');
      embed.addFields(
        { name: '👋 Pris par', value: agentNom, inline: true },
        { name: '⏰ Prochaine relance', value: 'Dans 24h si pas de résultat', inline: true },
      );

      await interaction.update({
        embeds: [embed],
        components: [buildButtons(rowIndex, 'claimed')],
      });

      console.log(`👋 ${agentNom} a pris le NO SHOW ligne ${rowIndex + 1}`);
      return;
    }

    // ── RDV REPRIS ──
    if (interaction.customId.startsWith('rdv_repris_')) {
      await updateCell(rowIndex, COL.REBOOKE, 'OUI');
      if (tracker) delete noShowTracker[rowIndex];

      const embed = buildNoShowEmbed(row, rowIndex, 'claimed')
        .setColor(0x00ff00)
        .setTitle('✅ NO SHOW — RDV Repris !');
      embed.addFields({ name: '✅ Clôturé par', value: agentNom, inline: false });

      await interaction.update({ embeds: [embed], components: [] });
      console.log(`✅ RDV repris pour ligne ${rowIndex + 1} par ${agentNom}`);
      return;
    }

    // ── RAPPEL PROGRAMMÉ ──
    if (interaction.customId.startsWith('rappel_programme_')) {
      const modal = new ModalBuilder()
        .setCustomId(`modal_rappel_${rowIndex}`)
        .setTitle('📅 Programmer un rappel')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('date_rappel')
              .setLabel('Date de rappel (JJ/MM/AAAA)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Ex: 20/03/2026')
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('note_rappel')
              .setLabel('Note (optionnel)')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Ex: Client dit de rappeler après 17h')
              .setRequired(false),
          ),
        );

      await interaction.showModal(modal);
      return;
    }

    // ── ABANDONNER ──
    if (interaction.customId.startsWith('abandonner_')) {
      if (tracker) delete noShowTracker[rowIndex];

      const embed = buildNoShowEmbed(row, rowIndex, 'open')
        .setColor(0x808080)
        .setTitle('⚫ NO SHOW — Abandonné');
      embed.addFields({ name: '❌ Abandonné par', value: agentNom, inline: false });

      await interaction.update({ embeds: [embed], components: [] });
      console.log(`❌ NO SHOW abandonné pour ligne ${rowIndex + 1} par ${agentNom}`);
      return;
    }
  }

  // ── MODALS ──
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_rappel_')) {
      const rowIndex = parseInt(interaction.customId.split('_').pop());
      const dateStr = interaction.fields.getTextInputValue('date_rappel');
      const note = interaction.fields.getTextInputValue('note_rappel') || '';
      const tracker = noShowTracker[rowIndex];
      const rows = await getSheetData();
      const row = rows[rowIndex];

      const reminderDate = parseDate(dateStr, '09:00');
      if (!reminderDate) {
        await interaction.reply({ content: '❌ Format de date invalide. Utilise JJ/MM/AAAA', ephemeral: true });
        return;
      }

      if (tracker) {
        tracker.reminderDate = reminderDate;
        tracker.assignedTo = interaction.user.username;
      }

      const embed = buildNoShowEmbed(row, rowIndex, 'reminder');
      embed.addFields(
        { name: '📅 Rappel programmé le', value: dateStr, inline: true },
        { name: '🙋 Par', value: interaction.user.username, inline: true },
      );
      if (note) embed.addFields({ name: '📝 Note', value: note, inline: false });

      try {
        const channel = await client.channels.fetch(process.env.NOSHOW_CHANNEL_ID);
        const msg = await channel.messages.fetch(tracker?.discordMessageId);
        await msg.edit({ embeds: [embed], components: [buildButtons(rowIndex, 'claimed')] });
      } catch {}

      await interaction.reply({
        content: `✅ Rappel programmé pour le **${dateStr}** pour **${row[COL.CLIENT]}**`,
        ephemeral: true,
      });
    }
  }
});

// ─── DÉMARRAGE ───────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Bot NO SHOW connecté en tant que ${client.user.tag}`);

  // Vérification toutes les 30 minutes
  cron.schedule('*/30 * * * *', () => {
    console.log('🔍 Vérification des NO SHOW...');
    checkNoShows();
  });

  // Première vérification immédiate
  checkNoShows();
});

client.login(process.env.DISCORD_TOKEN);
