require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
    new SlashCommandBuilder()
        .setName('close-support')
        .setDescription('Close current session and refresh customer page'),
    new SlashCommandBuilder()
        .setName('question')
        .setDescription('Send a pre-defined question (1-5)')
        .addIntegerOption(option =>
            option.setName('id')
                .setDescription('Question ID (1-5)')
                .setRequired(true)
                .addChoices(
                    { name: 'Q1: Technical Issue', value: 1 },
                    { name: 'Q2: Order Reference', value: 2 },
                    { name: 'Q3: Device/OS Info', value: 3 },
                    { name: 'Q4: Frequency', value: 4 },
                    { name: 'Q5: Steps Taken', value: 5 }
                )),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('⏳ Deploying Slash Commands...');
        await rest.put(
            Routes.applicationGuildCommands("1402301186685669416", "1377970060429099018"),
            { body: commands }
        );
        console.log('✅ Commands deployed to Guild!');
    } catch (e) { console.error(e); }
})();
