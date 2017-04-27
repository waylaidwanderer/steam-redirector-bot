const request = require('request');
const SteamClient = require('steam-client');
const SteamCommunity = require('steamcommunity');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

class Bot {
    constructor(config) {
        this.config = config;
        this.tag = `[${config.username}]`;
    }

    async start() {
        const steam = new SteamClient.CMClient();
        if (this.config.proxy) {
            steam.setHttpProxy(`http://${this.config.proxy}`);
        }
        this.client = new SteamUser(steam, {
            promptSteamGuardCode: false,
        });
        console.log(`${this.tag} Logging into Steam client...`);
        await this.loginToSteamClient();
        console.log(`${this.tag} Logged into Steam client with IP ${this.client.publicIP}!`);
        this.community = new SteamCommunity({
            request: request.defaults({
                proxy: this.config.proxy ? `http://${this.config.proxy}` : undefined,
            }),
        });
        this.manager = new TradeOfferManager({
            steam: this.client,
            community: this.community,
            language: 'en',
            cancelTime: 5 * 60 * 1000,
        });
        console.log(`${this.tag} Waiting 30s before logging into Steam Community website...`);
        await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        await this.retryLogin();
        this.community.on('debug', (message) => {
            if (message === 'Checking confirmations') return;
            console.log(`${this.tag} ${message}`);
        });
        this.community.on('sessionExpired', this.retryLogin.bind(this));
        this.community.startConfirmationChecker(10000, this.config.identity_secret);
        this.manager.on('newOffer', this.onNewOffer.bind(this));
        setInterval(() => {
            this.manager.getInventoryContents(730, 2, true, this.onInventoryLoaded.bind(this));
        }, 10 * 60 * 1000); // check inventory every 10 minutes and send items to target
    }

    async onInventoryLoaded(err, inventory) {
        if (err) {
            if (err.toString().includes('Failure')) return;
            console.log(`${this.tag} Error loading inventory: ${err}`);
            return;
        }
        if (inventory.length === 0) return;
        const chunkedItems = Bot.chunkArray(inventory, 50);
        console.log(`${this.tag} ${chunkedItems.length} groups of 50 items will be sent to ${this.config.target}.`);
        chunkedItems.forEach((items, i) => {
            const offer = this.manager.createOffer(this.config.target);
            items.forEach(item => offer.addMyItem(item));
            console.log(`${this.tag} Sending trade offer for group #${i + 1} of ${items.length} items.`);
            offer.send((sendErr) => {
                if (!sendErr) return;
                console.log(`${this.tag} ${sendErr}`);
            });
        });
    }

    async onNewOffer(offer) {
        if (offer.itemsToGive.length > 0) {
            offer.decline();
            console.log(`${this.tag} Declined trade offer from ${offer.partner.toString()} trying to take my items.`);
            return;
        }
        this.acceptOffer(offer);
    }

    async acceptOffer(offer, tries) {
        const currentTries = tries || 1;
        offer.accept(true, async (err) => {
            if (!err) {
                console.log(`${this.tag} Accepted trade offer #${offer.id} from ${offer.partner.toString()}.`);
                return;
            }
            // retry accept until successful
            const minToWait = err.toString().includes('(16)') ? 15 : currentTries;
            if (currentTries === 3) {
                console.log(`${this.tag} Failed to accept trade offer after 3 tries (might have been accepted already).`);
                return;
            }
            console.log(`${this.tag} Error accepting trade offer #${offer.id} from ${offer.partner.toString()}. Trying again in ${minToWait} minutes.`);
            await new Promise(resolve => setTimeout(resolve, minToWait * 60 * 1000));
            this.acceptOffer(offer, currentTries + 1);
        });
    }

    async loginToSteamClient() {
        const code = await this.generateAuthCode();
        console.log(`${this.tag} Using 2FA code "${code}".`);
        const loggedOnPromise = Bot.waitForEvent(this.client, 'loggedOn');
        this.client.logOn({
            accountName: this.config.username,
            password: this.config.password,
            twoFactorCode: code,
        });
        this.client.on('steamGuard', async (domain, callback) => {
            console.log(`${this.tag} Invalid 2FA code. Waiting 30s before generating new one...`);
            await new Promise(resolve => setTimeout(resolve, 30 * 1000));
            const newCode = await this.generateAuthCode();
            console.log(`${this.tag} New code generated: "${newCode}"`);
            callback(newCode);
        });
        await loggedOnPromise;
    }

    async loginToSteamCommunity() {
        const code = await this.generateAuthCode();
        console.log(`${this.tag} Using 2FA code "${code}".`);
        return new Promise((resolve, reject) => {
            this.community.login({
                accountName: this.config.username,
                password: this.config.password,
                twoFactorCode: code,
            }, (err, sessionID, cookies) => {
                if (err) return reject(err);
                return resolve(cookies);
            });
        });
    }

    /* eslint-disable no-await-in-loop */
    async retryLogin() {
        console.log(`${this.tag} Logging into Steam Community website...`);
        for (let i = 0; i < 3; i++) {
            try {
                const cookies = await this.loginToSteamCommunity();
                await this.setCookies(cookies);
                console.log(`${this.tag} Successfully logged in!`);
                return Promise.resolve();
            } catch (err) {
                if (err.toString().includes('SteamGuardMobile')) {
                    console.log(`${this.tag} ${err.message}`);
                } else {
                    console.log(`${this.tag} ${err}`);
                }
                await new Promise(resolve => setTimeout(resolve, 30 * 1000));
            }
        }
        console.log(`${this.tag} Can't login to account! Waiting a minute before trying again...`);
        await new Promise(resolve => setTimeout(resolve, 60 * 1000));
        await this.retryLogin();
        return Promise.resolve();
    }
    /* eslint-enable no-await-in-loop */

    async generateAuthCode() {
        return SteamTotp.generateAuthCode(this.config.shared_secret);
    }

    async setCookies(cookies) {
        return new Promise((resolve, reject) => {
            this.manager.setCookies(cookies, null, (err) => {
                if (err) return reject(err);
                return resolve();
            });
        });
    }

    static waitForEvent(obj, name) {
        return new Promise((resolve) => {
            obj.on(name, resolve);
        });
    }

    static chunkArray(arr, length) {
        const sets = [];
        const chunks = arr.length / length;
        for (let i = 0, j = 0; i < chunks; i++, j += length) {
            sets[i] = arr.slice(j, j + length);
        }
        return sets;
    }
}

module.exports = Bot;
