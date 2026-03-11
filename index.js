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

const COL = {
  HORODATEUR: 0,
  AGENT: 1,
  GARAGE: 2,
  CLIENT: 3,
  VEHICULE: 4,
  TEL: 5,
  DATE_RDV: 6,
  HEURE_RDV: 7,
  REBOOKE: 8,
  STATUT: 9,
};

const noShowTracker = {};
const GRACE_MINUTES = 120;

function isHeureOuvrable() {
  const now = new Date();
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const jour = paris.getDay();
  const heure = paris.getHours();
  return jour >= 1 && jour <= 6 && heure >= 8 && heure < 19;
}

function parseDate(dateStr, heureStr) {
  if (!dateStr) return null;
  try {
    const parts = dateStr.trim().split('/');
    if (parts.length !== 3) return null;
    const [day, month, year] = parts;
    let h = 0, m = 0;
    if (heureStr && heureStr.includes(':')) {
      const t = heureStr.trim().split(':');
      h = parseInt(t[0]) || 0;
      m = parseInt(t[1]) || 0;
    }
    const d = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), h, m, 0);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

function hoursElapsed(date) {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

function minutesElapsed(date) {
  return (Date.now() - date.getTime()) / (1000 * 60);
}

function isRdvValide(rdvDate) {
  if (!rdvDate || isNaN(rdvDate.getTime())) return false;
  const hierMinuit = new Date();
  hierMinuit.setDate(hierMinuit.getDate() - 1);
  hierMinuit.setHours(0, 0, 0, 0);
  return rdvDate >= hierMinuit;
}

function countNoShowsClient(rows, nomClient, garageClient, rowIndexActuel) {
  const nomLower = nomClient.trim().toLowerCase();
  const garageLower = garageClient.trim().toLowerCase();
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    if (i === rowIndexActuel) continue;
    const row = rows[i];
    if (!row || row.length < 10) continue;
    const statut = (row[COL.STATUT] || '').trim().toUpperCase();
    const nom = (row[COL.CLIENT] || '').trim().toLowerCase();
    const garage = (row[COL.GARAGE] || '').trim().toLowerCase();
    if (statut === 'NO SHOW' && nom === nomLower && garage === garageLower) count++;
  }
  return count;
}

function buildNoShowEmbed(row, rowIndex, status = 'open', extraFields = []) {
  const statusText = {
    open: '🚨 NON TRAITÉ — Disponible',
    claimed: '🙋 En cours de traitement',
    reminder: '⏰ Rappel programmé',
  }[status] || '🚨 NON TRAITÉ';

  const color = { open: 0xff0000, claimed: 0xffa500, reminder: 0x3498db }[status] || 0xff0000;

  const embed = new EmbedBuilder()
    .setColor(color)
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

  for (const f of extraFields) embed.addFields(f);
  return embed;
}

function buildButtons(rowIndex, phase = 'open') {
  const row = new ActionRowBuilder();
  if (phase === 'open') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`je_suis_dessus_${rowIndex}`).setLabel('🙋 Je suis dessus').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`je_le_prends_${rowIndex}`).setLabel('👋 Je le prends').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rdv_repris_${rowIndex}`).setLabel('✅ RDV Repris').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`client_venu_${rowIndex}`).setLabel('✋ Client VENU').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`abandonner_${rowIndex}`).setLabel('❌ Abandonner').setStyle(ButtonStyle.Danger),
    );
  } else if (phase === 'claimed') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`je_suis_dessus_${rowIndex}`).setLabel('🙋 Toujours dessus +24h').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rdv_repris_${rowIndex}`).setLabel('✅ RDV Repris').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`client_venu_${rowIndex}`).setLabel('✋ Client VENU').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rappel_programme_${rowIndex}`).setLabel('📅 Rappel').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`abandonner_${rowIndex}`).setLabel('❌ Abandonner').setStyle(ButtonStyle.Danger),
    );
  }
  return row;
}

async function findAgentMember(guild, agentNom) {
  try {
    const membres = await guild.members.fetch();
    const nomLower = (agentNom || '').toLowerCase().trim();
    const parts = nomLower.split(' ').filter(p => p.length > 2);
    let found = membres.find(m => m.user.username.toLowerCase() === nomLower);
    if (found) return found;
    found = membres.find(m => m.displayName.toLowerCase() === nomLower);
    if (found) return found;
    found = membres.find(m => parts.some(p => m.user.username.toLowerCase().includes(p) || m.displayName.toLowerCase().includes(p)));
    return found || null;
  } catch { return null; }
}

async function posterDansLesSalon(channel, row, i, rows, agentMembre, agentPrisEnMain) {
  const nbNoShows = countNoShowsClient(rows, row[COL.CLIENT], row[COL.GARAGE], i);
  const agentMention = agentMembre ? `<@${agentMembre.user.id}>` : row[COL.AGENT];
  const extraFields = [];

  if (nbNoShows >= 1) {
    extraFields.push({ name: '⚠️ CLIENT RÉCIDIVISTE', value: `Ce client a déjà **${nbNoShows} NO SHOW** sur ce garage !`, inline: false });
  }
  extraFields.push({ name: '👷 Agent concerné', value: agentMention, inline: true });

  let content, status;
  if (agentPrisEnMain) {
    status = 'claimed';
    content = `🚨 NO SHOW — **${agentMention} est déjà dessus !**`;
    extraFields.push({ name: '🙋 Pris en charge', value: agentMention, inline: true });
  } else {
    status = 'open';
    const alerteRecidiviste = nbNoShows >= 1 ? `\n⚠️ **RÉCIDIVISTE — ${nbNoShows + 1}ème NO SHOW !**` : '';
    content = `@everyone 🚨 NO SHOW non traité ! ${agentMention} n'a pas répondu.${alerteRecidiviste}`;
  }

  const embed = buildNoShowEmbed(row, i, status, extraFields);
  const phase = agentPrisEnMain ? 'claimed' : 'open';
  const msg = await channel.send({ content, embeds: [embed], components: [buildButtons(i, phase)] });

  noShowTracker[i].discordMessageId = msg.id;
  noShowTracker[i].postedInChannel = true;
  noShowTracker[i].lastRelance = new Date();
  if (agentPrisEnMain) noShowTracker[i].assignedTo = agentPrisEnMain;
}

async function checkNoShows() {
  if (!isHeureOuvrable()) { console.log('🕐 Hors horaires'); return; }
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
      if (statut !== 'NO SHOW') continue;
      if (rebooke === 'OUI') continue;
      const rdvDate = parseDate(row[COL.DATE_RDV], row[COL.HEURE_RDV]);
      if (!isRdvValide(rdvDate)) continue;
      const heuresEcoulees = hoursElapsed(rdvDate);
      const tracker = noShowTracker[i];

      if (tracker) {
        if (tracker.postedInChannel) {
          if (heuresEcoulees > (48 + 5 * 24)) {
            if (tracker.assignedTo) {
              try {
                const msg = await channel.messages.fetch(tracker.discordMessageId);
                const embed = buildNoShowEmbed(row, i, 'open', [{ name: '⚠️ 5 jours dépassés', value: "Ouvert à toute l'équipe !", inline: false }]);
                await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
                await channel.send(`@everyone ⚠️ **${row[COL.CLIENT]}** — 5 jours dépassés !`);
              } catch {}
              tracker.assignedTo = null;
            }
          }
          if (!tracker.assignedTo && !tracker.reminderDate && tracker.lastRelance && hoursElapsed(tracker.lastRelance) >= 12) {
            await channel.send(`@everyone 🔁 Rappel — **${row[COL.CLIENT]}** (${row[COL.GARAGE]}) n'a toujours pas été pris en charge !`);
            tracker.lastRelance = new Date();
          }
          if (tracker.assignedTo && tracker.claimedAt && hoursElapsed(tracker.claimedAt) >= 24) {
            const joursRestants = 5 - (tracker.jesuisCount || 0);
            if (joursRestants > 0) {
              try {
                const agentMembre = await findAgentMember(channel.guild, tracker.assignedTo);
                if (agentMembre) await agentMembre.send(`⏰ **Rappel NO SHOW — ${row[COL.CLIENT]}** (${row[COL.GARAGE]})\nTes 24h sont écoulées ! Il te reste **${joursRestants} jour(s)**.\n👉 Reclique **"🙋 Toujours dessus +24h"** !`);
              } catch {}
              try {
                const msg = await channel.messages.fetch(tracker.discordMessageId);
                const embed = buildNoShowEmbed(row, i, 'open', [{ name: '🔔 Relance', value: `**${tracker.assignedTo}** — 24h écoulées !`, inline: false }]);
                await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
              } catch {}
              tracker.assignedTo = null;
              tracker.claimedAt = null;
            } else {
              try {
                const msg = await channel.messages.fetch(tracker.discordMessageId);
                const embed = buildNoShowEmbed(row, i, 'open', [{ name: '🚨 5 jours épuisés', value: "Ouvert à toute l'équipe !", inline: false }]);
                await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
                await channel.send(`@everyone 🚨 **${row[COL.CLIENT]}** — 5 jours épuisés !`);
              } catch {}
              tracker.assignedTo = null;
              tracker.claimedAt = null;
            }
          }
          if (tracker.reminderDate && now >= tracker.reminderDate) {
            const heuresDepuisRappel = hoursElapsed(tracker.reminderDate);
            if (heuresDepuisRappel < 24) {
              if (!tracker.reminderNotified) {
                try {
                  const msg = await channel.messages.fetch(tracker.discordMessageId);
                  const embed = buildNoShowEmbed(row, i, 'claimed', [{ name: '⏰ Rappel atteint', value: `C'est le moment de rappeler **${row[COL.CLIENT]}** !`, inline: false }]);
                  await msg.edit({ embeds: [embed], components: [buildButtons(i, 'claimed')] });
                } catch {}
                tracker.reminderNotified = true;
              }
            } else {
              try {
                const msg = await channel.messages.fetch(tracker.discordMessageId);
                const embed = buildNoShowEmbed(row, i, 'open', [{ name: '🚨 Rappel non traité', value: `24h écoulées — ouvert à toute l'équipe !`, inline: false }]);
                await msg.edit({ embeds: [embed], components: [buildButtons(i, 'open')] });
                await channel.send(`@everyone 🔔 Rappel non traité pour **${row[COL.CLIENT]}** !`);
              } catch {}
              tracker.reminderDate = null;
              tracker.reminderNotified = false;
              tracker.assignedTo = null;
            }
          }
        }
        if (!tracker.postedInChannel && tracker.dmSentAt && minutesElapsed(tracker.dmSentAt) >= GRACE_MINUTES) {
          const agentMembre = await findAgentMember(channel.guild, row[COL.AGENT]);
          await posterDansLesSalon(channel, row, i, rows, agentMembre, tracker.assignedTo);
        }
        continue;
      }

      if (heuresEcoulees < 48) continue;

      const nomClient = (row[COL.CLIENT] || '').trim().toLowerCase();
      const garageClient = (row[COL.GARAGE] || '').trim().toLowerCase();
      const vehiculeClient = (row[COL.VEHICULE] || '').trim().toLowerCase();
      const dejaRepositionne = rows.some((autreRow, autreIndex) => {
        if (autreIndex === i || autreIndex === 0) return false;
        const autreNom = (autreRow[COL.CLIENT] || '').trim().toLowerCase();
        const autreGarage = (autreRow[COL.GARAGE] || '').trim().toLowerCase();
        const autreVehicule = (autreRow[COL.VEHICULE] || '').trim().toLowerCase();
        const autreStatut = (autreRow[COL.STATUT] || '').trim().toUpperCase();
        const autreDate = parseDate(autreRow[COL.DATE_RDV], autreRow[COL.HEURE_RDV]);
        const vehiculeMatch = autreVehicule.includes(vehiculeClient) || vehiculeClient.includes(autreVehicule);
        return autreNom === nomClient && autreGarage === garageClient && vehiculeMatch && autreDate && autreDate > now && autreStatut !== 'NO SHOW';
      });
      if (dejaRepositionne) continue;

      noShowTracker[i] = { agentNom: row[COL.AGENT], assignedTo: null, claimedAt: null, reminderDate: null, reminderNotified: false, discordMessageId: null, dmSentAt: null, postedInChannel: false, lastRelance: null, jesuisCount: 0, noteHistory: [] };

      const agentMembre = await findAgentMember(channel.guild, row[COL.AGENT]);
      const nbNoShows = countNoShowsClient(rows, row[COL.CLIENT], row[COL.GARAGE], i);
      try {
        if (agentMembre) {
          await agentMembre.send(`🚨 **NO SHOW — Action requise !**\nTon RDV avec **${row[COL.CLIENT]}** (${row[COL.GARAGE]}) est non venu.\n${nbNoShows >= 1 ? `⚠️ Client récidiviste — ${nbNoShows + 1}ème NO SHOW !\n` : ''}👉 Va dans **#no-show-équipe** et clique **"🙋 Je suis dessus"** !\nTu as **2h** pour répondre avant que la fiche soit ouverte à toute l'équipe.`);
        }
      } catch (e) { console.log(`⚠️ DM impossible : ${e.message}`); }
      noShowTracker[i].dmSentAt = new Date();
    }
  } catch (err) { console.error('Erreur checkNoShows:', err); }
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const rowIndex = parseInt(interaction.customId.split('_').pop());
    const tracker = noShowTracker[rowIndex];
    const rows = await getSheetData();
    const row = rows[rowIndex];
    if (!row) { await interaction.reply({ content: '❌ Ligne introuvable.', ephemeral: true }); return; }
    const agentNom = interaction.user.username;

    if (interaction.customId.startsWith('je_suis_dessus_')) {
      const rdvDateCheck = parseDate(row[COL.DATE_RDV], row[COL.HEURE_RDV]);
      if (rdvDateCheck && hoursElapsed(rdvDateCheck) > (48 + 5 * 24)) { await interaction.reply({ content: `❌ Délai maximum dépassé.`, ephemeral: true }); return; }
      const modal = new ModalBuilder().setCustomId(`modal_dessus_${rowIndex}`).setTitle('🙋 Je suis dessus — Note')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note_dessus').setLabel("Que s'est-il passé ?").setStyle(TextInputStyle.Paragraph).setPlaceholder('Ex: Pas répondu, je rappelle ce soir').setRequired(true)));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId.startsWith('je_le_prends_')) {
      if (tracker && tracker.assignedTo) { await interaction.reply({ content: `❌ Déjà pris par **${tracker.assignedTo}** !`, ephemeral: true }); return; }
      if (tracker) { tracker.assignedTo = agentNom; tracker.claimedAt = new Date(); }
      const embed = buildNoShowEmbed(row, rowIndex, 'claimed', [{ name: '👋 Pris par', value: agentNom, inline: true }, { name: '⏰ Prochaine relance', value: 'Dans 24h', inline: true }]);
      await interaction.update({ embeds: [embed], components: [buildButtons(rowIndex, 'claimed')] });
      return;
    }

    if (interaction.customId.startsWith('rdv_repris_')) {
      await updateCell(rowIndex, COL.REBOOKE, 'OUI');
      if (tracker) delete noShowTracker[rowIndex];
      const embed = buildNoShowEmbed(row, rowIndex, 'claimed').setColor(0x00ff00).setTitle('✅ NO SHOW — RDV Repris !');
      embed.addFields({ name: '✅ Clôturé par', value: agentNom, inline: false });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    if (interaction.customId.startsWith('client_venu_')) {
      await updateCell(rowIndex, COL.STATUT, 'VENU');
      if (tracker) delete noShowTracker[rowIndex];
      const embed = buildNoShowEmbed(row, rowIndex, 'claimed').setColor(0x00c851).setTitle('✋ Client était bien VENU');
      embed.addFields({ name: '✋ Corrigé par', value: agentNom, inline: false });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    if (interaction.customId.startsWith('rappel_programme_')) {
      const modal = new ModalBuilder().setCustomId(`modal_rappel_${rowIndex}`).setTitle('📅 Programmer un rappel')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date_rappel').setLabel('Date (JJ/MM/AAAA)').setStyle(TextInputStyle.Short).setPlaceholder('Ex: 20/03/2026').setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note_rappel').setLabel('Note (optionnel)').setStyle(TextInputStyle.Paragraph).setRequired(false)),
        );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId.startsWith('abandonner_')) {
      if (tracker) delete noShowTracker[rowIndex];
      const embed = buildNoShowEmbed(row, rowIndex, 'open').setColor(0x808080).setTitle('⚫ NO SHOW — Abandonné');
      embed.addFields({ name: '❌ Abandonné par', value: agentNom, inline: false });
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_dessus_')) {
      const rowIndex = parseInt(interaction.customId.split('_').pop());
      const note = interaction.fields.getTextInputValue('note_dessus');
      const tracker = noShowTracker[rowIndex];
      const rows = await getSheetData();
      const row = rows[rowIndex];
      const agentNom = interaction.user.username;
      if (tracker) { tracker.assignedTo = agentNom; tracker.claimedAt = new Date(); tracker.jesuisCount = (tracker.jesuisCount || 0) + 1; tracker.noteHistory = tracker.noteHistory || []; tracker.noteHistory.push({ agent: agentNom, jour: tracker.jesuisCount, note, date: new Date().toLocaleDateString('fr-FR') }); }
      const joursRestants = 5 - (tracker?.jesuisCount || 0);
      const extraFields = [{ name: `🙋 Jour ${tracker?.jesuisCount || 1}/5 — ${agentNom}`, value: note, inline: false }];
      if (tracker?.noteHistory?.length > 1) {
        const historique = tracker.noteHistory.slice(0, -1).map(n => `**Jour ${n.jour}** (${n.date}) — ${n.agent} : ${n.note}`).join('\n');
        extraFields.push({ name: '📖 Historique', value: historique.slice(0, 1024), inline: false });
      }
      if (tracker && !tracker.postedInChannel) {
        const channel = await client.channels.fetch(process.env.NOSHOW_CHANNEL_ID);
        const agentMembre = await findAgentMember(channel.guild, row[COL.AGENT]);
        await posterDansLesSalon(channel, row, rowIndex, rows, agentMembre, agentNom);
        try {
          const embed = buildNoShowEmbed(row, rowIndex, 'claimed', extraFields);
          const msg = await channel.messages.fetch(tracker.discordMessageId);
          await msg.edit({ embeds: [embed], components: [buildButtons(rowIndex, 'claimed')] });
        } catch {}
        await interaction.reply({ content: `✅ Note enregistrée ! Fiche visible. Il te reste **${joursRestants} jour(s)**.`, ephemeral: true });
        return;
      }
      const embed = buildNoShowEmbed(row, rowIndex, 'claimed', extraFields);
      try {
        const channel = await client.channels.fetch(process.env.NOSHOW_CHANNEL_ID);
        const msg = await channel.messages.fetch(tracker?.discordMessageId);
        await msg.edit({ embeds: [embed], components: [buildButtons(rowIndex, 'claimed')] });
      } catch {}
      await interaction.reply({ content: `✅ Note enregistrée ! Il te reste **${joursRestants} jour(s)**.`, ephemeral: true });
      return;
    }

    if (interaction.customId.startsWith('modal_rappel_')) {
      const rowIndex = parseInt(interaction.customId.split('_').pop());
      const dateStr = interaction.fields.getTextInputValue('date_rappel');
      const note = interaction.fields.getTextInputValue('note_rappel') || '';
      const tracker = noShowTracker[rowIndex];
      const rows = await getSheetData();
      const row = rows[rowIndex];
      const reminderDate = parseDate(dateStr, '09:00');
      if (!reminderDate) { await interaction.reply({ content: '❌ Format invalide. Utilise JJ/MM/AAAA', ephemeral: true }); return; }
      if (tracker) { tracker.reminderDate = reminderDate; tracker.assignedTo = interaction.user.username; tracker.reminderNotified = false; }
      const extraFields = [{ name: '📅 Rappel le', value: dateStr, inline: true }, { name: '🙋 Par', value: interaction.user.username, inline: true }];
      if (note) extraFields.push({ name: '📝 Note', value: note, inline: false });
      const embed = buildNoShowEmbed(row, rowIndex, 'reminder', extraFields);
      try {
        const channel = await client.channels.fetch(process.env.NOSHOW_CHANNEL_ID);
        const msg = await channel.messages.fetch(tracker?.discordMessageId);
        await msg.edit({ embeds: [embed], components: [buildButtons(rowIndex, 'claimed')] });
      } catch {}
      await interaction.reply({ content: `✅ Rappel programmé le **${dateStr}** pour **${row[COL.CLIENT]}**`, ephemeral: true });
    }
  }
});

client.once('ready', () => {
  console.log(`✅ Bot NO SHOW connecté : ${client.user.tag}`);
  cron.schedule('*/30 * * * *', () => { console.log('🔍 Vérification NO SHOW...'); checkNoShows(); });
  checkNoShows();
});

client.login(process.env.DISCORD_TOKEN);
