const config = require('./config');
const Bot = require('./Bot');

main();

async function main() {
    config.forEach((botConfig) => {
        const bot = new Bot(botConfig);
        bot.start();
    });
}