const config = require('./config');
const request = require('request');
const SteamClient = require('steam-client');
const SteamCommunity = require('steamcommunity');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

main();

async function main() {
    const steam = new SteamClient.CMClient();
    if (config.proxy) {
        steam.setHttpProxy(`http://${config.proxy}`);
    }
    const client = new SteamUser(steam);
    console.log(`Logging into ${config.username}...`);
    await loginToSteamClient(client, config);
    console.log(`Logged into Steam client with IP ${client.publicIP}!`);
    const community = new SteamCommunity({
        request: request.defaults({
            proxy: config.proxy ? `http://${config.proxy}` : undefined,
        }),
    });
    const manager = new TradeOfferManager({
        steam: client,
        community,
        language: 'en',
        cancelTime: 5 * 60 * 1000,
    });
    console.log('Waiting 30s...');
    await new Promise(resolve => setTimeout(resolve, 30 * 1000));
    await retryLogin(community, manager);
    manager.on('newOffer', onNewOffer);
    // TODO: check inventory and send trade offer to target in a loop
}

async function onNewOffer(offer) {
    if (offer.itemsToGive.length > 0) {
        offer.decline();
        console.log(`Declined trade offer from ${offer.partner.toString()} trying to take my items.`);
        return;
    }
    acceptOffer(offer);
}

async function acceptOffer(offer, tries) {
    const currentTries = tries || 1;
    offer.accept(true, async (err) => {
        if (!err) {
            console.log(`Accepted trade offer #${offer.id} from ${offer.partner.toString()}.`);
            return;
        }
        // retry accept until successful
        const minToWait = err.toString().includes('(16)') ? 15 : currentTries;
        if (currentTries === 3) {
            console.log('Failed to accept trade offer after 3 tries (might have been accepted already).');
            return;
        }
        console.log(`Error accepting trade offer #${offer.id} from ${offer.partner.toString()}. Trying again in ${minToWait} minutes.`);
        await new Promise(resolve => setTimeout(resolve, minToWait * 60 * 1000));
        acceptOffer(offer, currentTries + 1);
    });
}

async function loginToSteamClient(client) {
    const code = await generateAuthCode();
    console.log(`Using 2FA code "${code}".`);
    client.logOn({
        accountName: config.username,
        password: config.password,
        twoFactorCode: code,
    });
    client.on('steamGuard', async (domain, callback) => {
        console.log('Invalid 2FA code. Waiting 30s before generating new one...');
        await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        const newCode = await generateAuthCode();
        console.log(`New code generated: "${newCode}"`);
        callback(newCode);
    });
    await waitForEvent(client, 'loggedOn');
}

async function loginToSteamCommunity(community) {
    const code = await generateAuthCode();
    console.log(`Using 2FA code "${code}".`);
    return new Promise((resolve, reject) => {
        community.login({
            accountName: config.username,
            password: config.password,
            twoFactorCode: code,
        }, (err, sessionID, cookies) => {
            if (err) return reject(err);
            return resolve(cookies);
        });
    });
}

/* eslint-disable no-await-in-loop */
async function retryLogin(community, tradeOfferManager) {
    console.log('Logging into Steam Community website...');
    for (let i = 0; i < 3; i++) {
        try {
            const cookies = await loginToSteamCommunity(community);
            await setCookies(tradeOfferManager, cookies);
            console.log('Successfully logged in!');
            return Promise.resolve();
        } catch (err) {
            if (err.toString().includes('SteamGuardMobile')) {
                console.log(err.message);
            } else {
                console.log(err);
            }
            await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        }
    }
    console.log('Can\'t login to account! Waiting a minute before trying again...');
    await new Promise(resolve => setTimeout(resolve, 60 * 1000));
    await retryLogin(community, tradeOfferManager);
    return Promise.resolve();
}
/* eslint-enable no-await-in-loop */

async function generateAuthCode() {
    return new Promise((resolve, reject) => {
        SteamTotp.generateAuthCode(config.shared_secret, (err, code) => {
            if (err) return reject(err);
            return resolve(code);
        });
    });
}

async function setCookies(tradeOfferManager, cookies) {
    return new Promise((resolve, reject) => {
        tradeOfferManager.setCookies(cookies, null, (err) => {
            if (err) return reject(err);
            return resolve();
        });
    });
}

function waitForEvent(client, name) {
    return new Promise((resolve) => {
        client.on(name, resolve);
    });
}
