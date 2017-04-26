const config = require('./config');
const SteamClient = require('steam-client');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

//noinspection JSIgnoredPromiseFromCall
main();

async function main() {
    const steam = new SteamClient.CMClient();
    if (config.proxy) {
        steam.setHttpProxy(`http://${config.proxy}`);
    }
    const client = new SteamUser(steam);
    console.log(`Logging into ${config.username}...`);
    await loginToAccount(client, config);
    console.log(`Logged in with IP ${client.publicIP}!`);
    const manager = new TradeOfferManager({
        steam: client,
        language: 'en'
    });
    // TODO
}

async function loginToAccount(client, config) {
    client.logOn({
        accountName: config.username,
        password: config.password,
        twoFactorCode: SteamTotp.generateAuthCode(config.shared_secret)
    });
    // TODO: handle invalid 2fa code
    await waitForEvent(client, 'loggedOn');
}

function waitForEvent(client, name) {
    return new Promise(resolve => {
        client.on(name, () => {
            resolve();
        });
    });
}