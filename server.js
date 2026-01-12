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
mongoose.connect(process.env.MONGO_URI);
const Ticket = mongoose.model('Ticket', new mongoose.Schema({
    threadId: { type: String, unique: true },
    customerName: String,
    status: { type: String, default: 'open' },
    messages: [{ sender: String, content: String, timestamp: { type: Date, default: Date.now } }]
}));

// --- AUTO DEPLOY SLASH COMMANDS ---
const commands = [
    new SlashCommandBuilder().setName('close-support').setDescription('Close session and delete thread'),
    new SlashCommandBuilder().setName('questions-list').setDescription('Show all available pre-defined questions'),
    new SlashCommandBuilder().setName('question').setDescription('Send a question to customer')
        .addIntegerOption(opt => opt.setName('id').setDescription('Question ID (1-5)').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(BOT_ID, GUILD_ID), { body: commands });
        console.log('✅ Commands Updated');
    } catch (e) { console.error(e); }
})();

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel] 
});

// --- API ENDPOINTS (Cloudflare Bypass) ---
const getHeaders = () => ({
    'Content-Type': 'application/json',
    'User-Agent': process.env.CUSTOM_USER_AGENT || 'PRMGVYT-SUPPORT-BOT-SECURE'
});

app.post('/api/tickets/start', async (req, res) => {
    try {
        const channel = await client.channels.fetch(process.env.SUPPORT_CHANNEL_ID);
        const thread = await channel.threads.create({
            name: `🔴 Support - ${req.body.name}`,
            type: ChannelType.PublicThread
        });
        await new Ticket({ threadId: thread.id, customerName: req.body.name }).save();
        res.json({ success: true, threadId: thread.id });
    } catch (e) { res.json({ success: false }); }
});

// Quan trọng: API này dùng để Web lấy tin nhắn mới
app.get('/api/tickets/history/:threadId', async (req, res) => {
    const ticket = await Ticket.findOne({ threadId: req.params.threadId });
    res.json({ 
        success: true, 
        messages: ticket ? ticket.messages : [], 
        status: ticket ? ticket.status : 'closed' 
    });
});

app.post('/api/tickets/send', async (req, res) => {
    const { threadId, message, author } = req.body;
    const thread = await client.channels.fetch(threadId);
    await thread.send(`**${author}**: ${message}`);
    await Ticket.findOneAndUpdate({ threadId }, { $push: { messages: { sender: author, content: message } } });
    res.json({ success: true });
});

// --- DISCORD INTERACTION ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.id !== ADMIN_ID) return interaction.reply({ content: "❌ No Perms", ephemeral: true });

    if (interaction.commandName === 'questions-list') {
        let list = "**Available Questions:**\n";
        for (let id in QUESTIONS) list += `**${id}**: ${QUESTIONS[id]}\n`;
        return interaction.reply({ content: list, ephemeral: true });
    }

    if (interaction.commandName === 'close-support') {
        await Ticket.findOneAndUpdate({ threadId: interaction.channelId }, { status: 'closed' });
        await interaction.reply('🔒 Closing in 5s...');
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
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
app.listen(process.env.PORT || 3000);
