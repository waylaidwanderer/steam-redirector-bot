const config = require('./config');
const Bot = require('./Bot');

main();

async function main() {
    global.tradeBanAlerts = {};
    config.bots.forEach((botConfig) => {
        const bot = new Bot(botConfig);
        bot.start();
    });
}
