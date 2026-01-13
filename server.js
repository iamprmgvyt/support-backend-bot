require('dotenv').config();
const { 
    Client, GatewayIntentBits, Partials, EmbedBuilder, 
    ChannelType, REST, Routes, SlashCommandBuilder, AttachmentBuilder 
} = require('discord.js');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const CryptoJS = require('crypto-js');
const axios = require('axios');

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

let tempOTP = { code: null, expires: null, action: null, data: null };

// --- DATABASE SETUP ---
mongoose.connect(process.env.MONGO_URI);

const TicketSchema = new mongoose.Schema({
    threadId: { type: String, unique: true },
    userId: String,
    username: String,
    customerName: String,
    status: { type: String, default: 'open' },
    messages: [{ 
        sender: String, 
        content: String, 
        timestamp: { type: Date, default: Date.now } 
    }]
});
const Ticket = mongoose.model('Ticket', TicketSchema);

const Blacklist = mongoose.model('Blacklist', new mongoose.Schema({
    userId: { type: String, unique: true },
    reason: String,
    timestamp: { type: Date, default: Date.now }
}));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// --- DISCORD SLASH COMMANDS DEPLOYMENT ---
const commands = [
    new SlashCommandBuilder().setName('close-support').setDescription('Close session and delete thread'),
    new SlashCommandBuilder().setName('questions-list').setDescription('Show all available pre-defined questions'),
    new SlashCommandBuilder().setName('question').setDescription('Send a pre-defined question').addIntegerOption(opt => opt.setName('id').setDescription('Question ID (1-5)').setRequired(true)),
    new SlashCommandBuilder().setName('backup').setDescription('Generate an encrypted backup'),
    new SlashCommandBuilder().setName('delete-all').setDescription('Wipe all ticket data'),
    new SlashCommandBuilder().setName('confirm-otp').setDescription('Verify OTP code').addStringOption(opt => opt.setName('code').setDescription('6-digit code').setRequired(true)),
    new SlashCommandBuilder().setName('restore').setDescription('Restore from file').addAttachmentOption(opt => opt.setName('file').setDescription('Backup JSON').setRequired(true)).addStringOption(opt => opt.setName('otp').setDescription('Enter OTP').setRequired(true)),
    new SlashCommandBuilder().setName('ban-user').setDescription('Ban user from support').addStringOption(opt => opt.setName('userid').setDescription('Discord ID').setRequired(true)).addStringOption(opt => opt.setName('reason').setDescription('Reason')),
    new SlashCommandBuilder().setName('unban-user').setDescription('Unban user').addStringOption(opt => opt.setName('userid').setDescription('Discord ID').setRequired(true))
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(BOT_ID, GUILD_ID), { body: commands });
        console.log('✅ Global Slash Commands Synchronized');
    } catch (e) { console.error('❌ Command Deploy Error:', e); }
})();

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel] 
});

// --- UTILS ---
const generateOTP = async (action, data = null) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    tempOTP = { code, expires: Date.now() + 600000, action, data };
    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.ADMIN_EMAIL,
        subject: `[SECURITY ALERT] OTP for ${action.toUpperCase()}`,
        html: `<div style="font-family:sans-serif; padding:20px; border:1px solid #00ffa3;">
                <h2>Security Code Request</h2>
                <p>An administrative action <b>${action}</b> has been requested.</p>
                <h1 style="color:#00ffa3; letter-spacing:5px;">${code}</h1>
                <p>This code expires in 10 minutes.</p>
               </div>`
    });
};

// --- API: AUTHENTICATION & CALLBACK ---

// 1. Discord OAuth2 Callback (Trình duyệt sẽ chuyển hướng về đây)
app.get('/api/auth/callback', (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("No authorization code provided.");
    // Chuyển hướng về trang chủ kèm theo code để Frontend xử lý tiếp
    res.redirect(`https://support-bot.prmgvyt.io.vn/?code=${code}`);
});

// 2. Exchange Code for User Data
app.post('/api/auth/discord', async (req, res) => {
    const { code } = req.body;
    try {
        const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            client_secret: process.env.DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.DISCORD_REDIRECT_URI,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });

        res.json({ success: true, user: userRes.data });
    } catch (e) { 
        console.error(e.response?.data || e.message);
        res.status(401).json({ success: false }); 
    }
});

// --- API: TICKET CORE ---

// 3. Lấy log cũ của User (Dùng cho Main Page)
app.get('/api/tickets/user/:userId', async (req, res) => {
    try {
        const tickets = await Ticket.find({ userId: req.params.userId }).sort({ _id: -1 }).limit(5);
        res.json({ success: true, tickets });
    } catch (e) { res.status(500).json({ success: false }); }
});

// 4. Khởi tạo Ticket mới
app.post('/api/tickets/start', async (req, res) => {
    try {
        const { name, userId, username, avatar, banner } = req.body;

        const isBanned = await Blacklist.findOne({ userId });
        if (isBanned) return res.status(403).json({ success: false, message: `ACCESS DENIED: You are banned. Reason: ${isBanned.reason}` });

        const channel = await client.channels.fetch(process.env.SUPPORT_CHANNEL_ID);
        const vnTime = new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" });

        const thread = await channel.threads.create({ 
            name: `🔴 ${username} - ${name}`, 
            type: ChannelType.PublicThread 
        });

        const infoEmbed = new EmbedBuilder()
            .setTitle('🎫 New Session Activated')
            .setColor('#00ffa3')
            .setThumbnail(avatar ? `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png` : null)
            .setImage(banner ? `https://cdn.discordapp.com/banners/${userId}/${banner}.png` : null)
            .addFields(
                { name: '👤 Customer Name', value: name, inline: true },
                { name: '🆔 Discord ID', value: `\`${userId}\``, inline: true },
                { name: '🏷️ Discord Tag', value: username, inline: true },
                { name: '⏰ Created At (VN)', value: vnTime }
            )
            .setFooter({ text: 'PRMGVYT Security Protocol' });

        await thread.send({ embeds: [infoEmbed] });

        const newTicket = new Ticket({ 
            threadId: thread.id, 
            userId, 
            username, 
            customerName: name,
            messages: [{ sender: 'System', content: 'Connection Established' }]
        });
        await newTicket.save();

        res.json({ success: true, threadId: thread.id });
    } catch (e) { res.json({ success: false }); }
});

app.get('/api/tickets/history/:threadId', async (req, res) => {
    const ticket = await Ticket.findOne({ threadId: req.params.threadId });
    res.json({ success: true, messages: ticket ? ticket.messages : [], status: ticket ? ticket.status : 'closed' });
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

// --- DISCORD BOT LOGIC ---

client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return;
    if (i.user.id !== ADMIN_ID) return i.reply({ content: "❌ Unauthorized.", ephemeral: true });

    if (i.commandName === 'ban-user') {
        const userId = i.options.getString('userid');
        const reason = i.options.getString('reason') || 'No reason specified';
        await Blacklist.findOneAndUpdate({ userId }, { reason }, { upsert: true });
        return i.reply(`✅ Banned <@${userId}> (\`${userId}\`). Reason: ${reason}`);
    }

    if (i.commandName === 'unban-user') {
        const userId = i.options.getString('userid');
        await Blacklist.deleteOne({ userId });
        return i.reply(`✅ User \`${userId}\` has been removed from blacklist.`);
    }

    if (i.commandName === 'backup' || i.commandName === 'delete-all') {
        await generateOTP(i.commandName);
        return i.reply({ content: `🔐 Security OTP sent to Admin Email. Use \`/confirm-otp\` to execute.`, ephemeral: true });
    }

    if (i.commandName === 'confirm-otp') {
        const code = i.options.getString('code');
        if (!tempOTP.code || Date.now() > tempOTP.expires || code !== tempOTP.code) return i.reply("❌ Invalid or expired OTP.");

        const action = tempOTP.action;
        tempOTP = { code: null };

        if (action === 'backup') {
            const data = await Ticket.find();
            const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), process.env.BACKUP_ENCRYPTION_KEY).toString();
            const attachment = new AttachmentBuilder(Buffer.from(encrypted, 'utf-8'), { name: `DATABASE_BACKUP_${Date.now()}.json` });
            
            try {
                await i.user.send({ content: "📦 **ENCRYPTED DATABASE BACKUP**\nKeep this file safe for restoration.", files: [attachment] });
                return i.reply({ content: "✅ Backup sent to your DM.", ephemeral: true });
            } catch (e) {
                return i.reply({ content: "❌ Failed to send DM. Check your Privacy Settings.", ephemeral: true });
            }
        }

        if (action === 'delete-all') {
            await Ticket.deleteMany({});
            return i.reply("💥 **SYSTEM WIPE COMPLETE**: All tickets deleted from database.");
        }
    }

    if (i.commandName === 'restore') {
        const file = i.options.getAttachment('file');
        const otp = i.options.getString('otp'); // Optional OTP verification
        
        try {
            const response = await axios.get(file.url);
            const bytes = CryptoJS.AES.decrypt(response.data, process.env.BACKUP_ENCRYPTION_KEY);
            const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
            
            await Ticket.deleteMany({});
            await Ticket.insertMany(decryptedData);
            return i.reply("✅ **RESTORE SUCCESSFUL**: Database state recovered.");
        } catch (e) { return i.reply("❌ **RESTORE FAILED**: File corrupted or wrong encryption key."); }
    }

    if (i.commandName === 'questions-list') {
        let list = "### 📝 Available Questions:\n" + Object.entries(QUESTIONS).map(([id, text]) => `**${id}**: ${text}`).join('\n');
        return i.reply({ content: list, ephemeral: true });
    }

    if (i.commandName === 'close-support') {
        await Ticket.findOneAndUpdate({ threadId: i.channelId }, { status: 'closed' });
        await i.reply('🔒 **SESSION TERMINATED**: Deleting thread in 5s...');
        setTimeout(() => i.channel.delete().catch(() => {}), 5000);
    }

    if (i.commandName === 'question') {
        const id = i.options.getInteger('id').toString();
        if (QUESTIONS[id]) {
            const qText = `📝 PRE-SUPPORT QUESTION: ${QUESTIONS[id]}`;
            await Ticket.findOneAndUpdate({ threadId: i.channelId }, { $push: { messages: { sender: 'System', content: qText } } });
            return i.reply({ content: `✅ Sent Question #${id}`, ephemeral: true });
        }
    }
});

// Lưu tin nhắn từ Admin trong Thread vào Database
client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.channel.isThread() || msg.content.startsWith('/')) return;
    await Ticket.findOneAndUpdate({ threadId: msg.channelId }, { $push: { messages: { sender: 'Admin', content: msg.content } } });
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Terminal Server running on port ${PORT}`));
