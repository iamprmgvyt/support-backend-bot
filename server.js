require('dotenv').config();
const { 
    Client, GatewayIntentBits, Partials, EmbedBuilder, 
    ChannelType, REST, Routes, SlashCommandBuilder 
} = require('discord.js');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const ADMIN_ID = "1262304052361035857";
const GUILD_ID = "1377970060429099018";
const BOT_ID = "1402301186685669416";
const QUESTIONS = {
    "1": "What specific technical issue are you experiencing with the platform?",
    "2": "Could you please provide your order ID or transaction reference?",
    "3": "Which operating system or device are you currently using?",
    "4": "Is this your first time encountering this problem, or has it happened before?",
    "5": "What steps have you already taken to try and resolve the issue?"
};

// --- DATABASE SETUP ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

const Ticket = mongoose.model('Ticket', new mongoose.Schema({
    threadId: { type: String, unique: true },
    customerName: String,
    status: { type: String, default: 'open' },
    messages: [{ sender: String, content: String, timestamp: { type: Date, default: Date.now } }]
}));

// --- AUTO DEPLOY SLASH COMMANDS ---
const commands = [
    new SlashCommandBuilder().setName('close-support').setDescription('Close session'),
    new SlashCommandBuilder().setName('question').setDescription('Send FAQ')
        .addIntegerOption(opt => opt.setName('id').setDescription('1-5').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('⏳ Refreshing Slash Commands...');
        await rest.put(Routes.applicationGuildCommands(BOT_ID, GUILD_ID), { body: commands });
        console.log('✅ Slash Commands Registered!');
    } catch (e) { console.error('❌ Deploy Error:', e); }
})();

// --- DISCORD BOT SETUP ---
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel] 
});

// --- API ENDPOINTS (With Cloudflare Bypass Header) ---
const commonHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': process.env.CUSTOM_USER_AGENT || 'PRMGVYT-SUPPORT-BOT-SECURE'
};

app.post('/api/tickets/start', async (req, res) => {
    try {
        const channel = await client.channels.fetch(process.env.SUPPORT_CHANNEL_ID);
        const thread = await channel.threads.create({
            name: `🔴 Support - ${req.body.name}`,
            type: ChannelType.PublicThread
        });

        const embed = new EmbedBuilder()
            .setTitle('🎫 New Session').setColor(0x00FFA3)
            .setDescription(`Customer **${req.body.name}** is waiting.\nUse \`/question\` or \`/close-support\`.`);

        await thread.send({ embeds: [embed] });
        await new Ticket({ threadId: thread.id, customerName: req.body.name }).save();
        res.json({ success: true, threadId: thread.id });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/tickets/history/:threadId', async (req, res) => {
    const ticket = await Ticket.findOne({ threadId: req.params.threadId });
    res.json({ success: true, messages: ticket?.messages || [], status: ticket?.status || 'open' });
});

// --- DISCORD EVENTS ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== ADMIN_ID) return interaction.reply({ content: "❌ Unauthorized", ephemeral: true });

    if (interaction.commandName === 'close-support') {
        await Ticket.findOneAndUpdate({ threadId: interaction.channelId }, { status: 'closed' });
        return interaction.reply('🔒 Session Closed.');
    }

    if (interaction.commandName === 'question') {
        const id = interaction.options.getInteger('id').toString();
        if (QUESTIONS[id]) {
            const qText = `📝 PRE-SUPPORT QUESTION: ${QUESTIONS[id]}`;
            await Ticket.findOneAndUpdate({ threadId: interaction.channelId }, { $push: { messages: { sender: 'System', content: qText } } });
            return interaction.reply({ content: `✅ Sent Q#${id}`, ephemeral: true });
        }
    }
});

client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.channel.isThread() || msg.content.startsWith('/')) return;
    await Ticket.findOneAndUpdate({ threadId: msg.channelId }, { $push: { messages: { sender: 'Admin', content: msg.content } } });
});

client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000, () => console.log('🚀 Server running'));
