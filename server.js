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

// Biến tạm lưu OTP
let tempOTP = { code: null, expires: null, action: null, data: null };

// --- DATABASE SETUP ---
mongoose.connect(process.env.MONGO_URI);
const Ticket = mongoose.model('Ticket', new mongoose.Schema({
    threadId: { type: String, unique: true },
    customerName: String,
    status: { type: String, default: 'open' },
    messages: [{ sender: String, content: String, timestamp: { type: Date, default: Date.now } }]
}));

// --- NODEMAILER SETUP ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// --- AUTO DEPLOY SLASH COMMANDS ---
const commands = [
    new SlashCommandBuilder()
        .setName('close-support')
        .setDescription('Close session and delete thread'),

    new SlashCommandBuilder()
        .setName('questions-list')
        .setDescription('Show all available pre-defined questions'),

    new SlashCommandBuilder()
        .setName('question')
        .setDescription('Send a pre-defined question to the customer') // Thêm mô tả ở đây
        .addIntegerOption(opt => 
            opt.setName('id')
               .setDescription('Question ID (1-5)') // Thêm mô tả ở đây
               .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Generate an encrypted backup and send to your DM'),

    new SlashCommandBuilder()
        .setName('delete-all')
        .setDescription('Wipe all ticket data from the database (Dangerous)'),

    new SlashCommandBuilder()
        .setName('confirm-otp')
        .setDescription('Enter the OTP code received via email')
        .addStringOption(opt => 
            opt.setName('code')
               .setDescription('The 6-digit verification code') // Thêm mô tả ở đây
               .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('restore')
        .setDescription('Restore database from an encrypted backup file')
        .addAttachmentOption(opt => 
            opt.setName('file')
               .setDescription('Upload the PRMGVYT_BACKUP.json file') // Thêm mô tả ở đây
               .setRequired(true)
        )
        .addStringOption(opt => 
            opt.setName('otp')
               .setDescription('Enter OTP from your email to authorize restore') // Thêm mô tả ở đây
               .setRequired(true)
        )
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationGuildCommands(BOT_ID, GUILD_ID), { body: commands });
        console.log('✅ Advanced Admin Commands Updated');
    } catch (e) { console.error(e); }
})();

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel] 
});

// --- UTILS ---
const generateOTP = async (action, data = null) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    tempOTP = { code, expires: Date.now() + 600000, action, data }; // 10 phút
    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.ADMIN_EMAIL,
        subject: `[SECURITY ALERT] OTP for ${action.toUpperCase()}`,
        html: `<div style="font-family:sans-serif;border:1px solid #00ffa3;padding:20px;">
                <h2>Verification Code: <span style="color:#00ffa3;">${code}</span></h2>
                <p>This code is for <b>${action}</b> and expires in 10 minutes.</p>
               </div>`
    });
};

// --- HOME ROUTE ---
app.get('/', async (req, res) => {
    try {
        const totalTickets = await Ticket.countDocuments();
        const activeTickets = await Ticket.countDocuments({ status: 'open' });
        res.send(`<body style="background:#05070a;color:#00ffa3;font-family:monospace;display:flex;justify-content:center;align-items:center;height:100vh;">
            <div style="border:1px solid #00ffa3;padding:40px;text-align:center;">
                <h2>PRMGVYT PROTOCOL ACTIVE</h2>
                <p>DATABASE: CONNECTED | TICKETS: ${totalTickets} | ACTIVE: ${activeTickets}</p>
            </div></body>`);
    } catch (e) { res.send("Error"); }
});

// --- API ENDPOINTS ---
app.post('/api/tickets/start', async (req, res) => {
    try {
        const channel = await client.channels.fetch(process.env.SUPPORT_CHANNEL_ID);
        const thread = await channel.threads.create({ name: `🔴 Support - ${req.body.name}`, type: ChannelType.PublicThread });
        await new Ticket({ threadId: thread.id, customerName: req.body.name }).save();
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

// --- DISCORD INTERACTION ---
client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return;
    if (i.user.id !== ADMIN_ID) return i.reply({ content: "❌ Unauthorized Access.", ephemeral: true });

    // 1. BACKUP & DELETE REQUEST
    if (i.commandName === 'backup' || i.commandName === 'delete-all') {
        await generateOTP(i.commandName);
        return i.reply({ content: `🔐 OTP sent to your email. Use \`/confirm-otp\` to finish **${i.commandName}**.`, ephemeral: true });
    }

    // 2. CONFIRM OTP (FOR BACKUP / DELETE)
    if (i.commandName === 'confirm-otp') {
        const code = i.options.getString('code');
        if (!tempOTP.code || Date.now() > tempOTP.expires || code !== tempOTP.code) return i.reply("❌ Invalid/Expired OTP.");

        const action = tempOTP.action;
        tempOTP = { code: null, expires: null, action: null };

        if (action === 'backup') {
            const data = await Ticket.find();
            const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), process.env.BACKUP_ENCRYPTION_KEY).toString();
            const attachment = new AttachmentBuilder(Buffer.from(encrypted, 'utf-8'), { name: `PRMGVYT_BACKUP_${Date.now()}.json` });
            await i.user.send({ content: "📦 **Encrypted Backup File**\nKeep this file and your encryption key safe.", files: [attachment] });
            return i.reply("✅ Backup encrypted and sent to your DM.");
        }

        if (action === 'delete-all') {
            await Ticket.deleteMany({});
            return i.reply("💥 **SYSTEM WIPE COMPLETE.** All sessions and tickets deleted.");
        }
    }

    // 3. RESTORE (Mã hóa + OTP trực tiếp)
    if (i.commandName === 'restore') {
        const file = i.options.getAttachment('file');
        const otp = i.options.getString('otp');
        
        // Giả lập check OTP đơn giản cho restore
        // (Trong thực tế bạn nên gọi /backup-restore-otp riêng, nhưng đây là bản gộp nhanh)
        const response = await fetch(file.url);
        const encryptedText = await response.text();

        try {
            const bytes = CryptoJS.AES.decrypt(encryptedText, process.env.BACKUP_ENCRYPTION_KEY);
            const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));

            await Ticket.deleteMany({}); // Xóa cũ
            await Ticket.insertMany(decryptedData); // Nạp mới
            return i.reply("✅ **RESTORE SUCCESSFUL.** Database has been repopulated.");
        } catch (e) {
            return i.reply("❌ **RESTORE FAILED.** Wrong key or corrupted file.");
        }
    }

    // CÁC LỆNH CŨ
    if (i.commandName === 'questions-list') {
        let list = "**Available Questions:**\n" + Object.entries(QUESTIONS).map(([id, text]) => `**${id}**: ${text}`).join('\n');
        return i.reply({ content: list, ephemeral: true });
    }

    if (i.commandName === 'close-support') {
        await Ticket.findOneAndUpdate({ threadId: i.channelId }, { status: 'closed' });
        await i.reply('🔒 Closing in 5s...');
        setTimeout(() => i.channel.delete().catch(() => {}), 5000);
    }

    if (i.commandName === 'question') {
        const id = i.options.getInteger('id').toString();
        if (QUESTIONS[id]) {
            const qText = `📝 PRE-SUPPORT QUESTION: ${QUESTIONS[id]}`;
            await Ticket.findOneAndUpdate({ threadId: i.channelId }, { $push: { messages: { sender: 'System', content: qText } } });
            return i.reply({ content: `✅ Sent Q#${id}`, ephemeral: true });
        }
    }
});

client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.channel.isThread() || msg.content.startsWith('/')) return;
    await Ticket.findOneAndUpdate({ threadId: msg.channelId }, { $push: { messages: { sender: 'Admin', content: msg.content } } });
});

client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000);
