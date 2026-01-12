require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ChannelType } = require('discord.js');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const ADMIN_ID = "1262304052361035857";
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

const ticketSchema = new mongoose.Schema({
    threadId: { type: String, unique: true },
    customerName: String,
    status: { type: String, default: 'open' },
    messages: [{ sender: String, content: String, timestamp: { type: Date, default: Date.now } }]
});
const Ticket = mongoose.model('Ticket', ticketSchema);

// --- DISCORD BOT SETUP ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel] 
});

client.once('ready', () => console.log(`✅ Bot Live: ${client.user.tag}`));

// --- API ENDPOINTS ---
app.post('/api/tickets/start', async (req, res) => {
    try {
        const { name } = req.body;
        const channel = await client.channels.fetch(process.env.SUPPORT_CHANNEL_ID);
        const thread = await channel.threads.create({
            name: `🔴 Support - ${name}`,
            type: ChannelType.PublicThread
        });

        const embed = new EmbedBuilder()
            .setTitle('🎫 New Session')
            .setColor(0x00FFA3)
            .setDescription(`Customer **${name}** is waiting for assistance.\n\n**Commands:**\n- \`/question [id]\`\n- \`/close-support\``);

        await thread.send({ embeds: [embed] });
        await new Ticket({ threadId: thread.id, customerName: name }).save();

        res.json({ success: true, threadId: thread.id });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ success: false }); 
    }
});

app.get('/api/tickets/history/:threadId', async (req, res) => {
    const ticket = await Ticket.findOne({ threadId: req.params.threadId });
    res.json({ success: true, messages: ticket?.messages || [], status: ticket?.status || 'open' });
});

app.post('/api/tickets/send', async (req, res) => {
    try {
        const { threadId, message, author } = req.body;
        const thread = await client.channels.fetch(threadId);
        await thread.send(`**${author}**: ${message}`);
        await Ticket.findOneAndUpdate({ threadId }, { $push: { messages: { sender: author, content: message } } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- DISCORD COMMANDS (Slash & Message) ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Chỉ Admin ID được phép chạy lệnh
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ content: "❌ Unauthorized: You are not allowed to use these commands.", ephemeral: true });
    }

    const { commandName, channelId, options } = interaction;

    if (commandName === 'close-support') {
        await Ticket.findOneAndUpdate({ threadId: channelId }, { status: 'closed' });
        return interaction.reply('🔒 **Session Closed.** Customer page will refresh.');
    }

    if (commandName === 'question') {
        const id = options.getInteger('id').toString();
        if (QUESTIONS[id]) {
            const qText = `📝 PRE-SUPPORT QUESTION: ${QUESTIONS[id]}`;
            await Ticket.findOneAndUpdate({ threadId: channelId }, { $push: { messages: { sender: 'System', content: qText } } });
            return interaction.reply({ content: `✅ Sent Question #${id}`, ephemeral: true });
        }
    }
});

// Tin nhắn Admin bình thường (Gõ không dùng lệnh)
client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.channel.isThread()) return;
    
    // Nếu tin nhắn bắt đầu bằng /, bỏ qua vì interactionCreate sẽ xử lý
    if (msg.content.startsWith('/')) return;

    await Ticket.findOneAndUpdate(
        { threadId: msg.channelId }, 
        { $push: { messages: { sender: 'Admin', content: msg.content } } }
    );
});

client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
