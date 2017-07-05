const request = require('request');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

class Bot {
    constructor(config) {
        this.config = config;
        this.tag = `[${config.username}]`;
        this.recoverFromFailure = true;
    }

    async start() {
        if (!this.getTarget()) {
            console.log(`${this.tag} Invalid target set. Aborting.`);
            return;
        }
        const r = request.defaults({
            proxy: this.config.proxy ? `http://${this.config.proxy}` : undefined,
        });
        this.community = new SteamCommunity({
            request: r,
        });
        this.manager = new TradeOfferManager({
            community: this.community,
            language: 'en',
            pollInterval: 5000,
            globalAssetCache: true,
            cancelTime: 5 * 60 * 1000,
        });
        console.log(`${this.tag} Logging into Steam client with proxy ${this.config.proxy}...`);
        const cookies = await this.login();
        console.log(`${this.tag} Successfully logged in!`);
        await this.setCookies(cookies);
        this.community.on('debug', (message) => {
            if (message === 'Checking confirmations') return;
            console.log(`${this.tag} ${message}`);
        });
        this.community.on('sessionExpired', this.retryLogin.bind(this));
        this.community.startConfirmationChecker(10000, this.config.identity_secret);
        this.manager.on('newOffer', this.onNewOffer.bind(this));
        // Every minute, if we need to recover from failure (i.e. `getExchangeDetails` failed),
        // simply send all inventory items to target.
        setInterval(() => {
            if (this.recoverFromFailure) {
                this.manager.getInventoryContents(730, 2, true, this.onInventoryLoaded.bind(this));
            }
        }, 60 * 1000);
    }

    cancelOutgoingTradeOffers() {
        this.manager.getOffers(TradeOfferManager.EOfferFilter.ActiveOnly, null, (err, sent) => {
            if (err) {
                console.log(`${this.tag} Couldn't fetch active offers.`);
                return;
            }
            console.log(`${this.tag} Cancelling ${sent.length} active trade offers sent by us.`);
            sent.forEach(offer => offer.cancel());
        });
    }

    async onInventoryLoaded(err, inventory) {
        if (err) {
            if (err.toString().includes('Failure')) return;
            console.log(`${this.tag} Error loading inventory: ${err}`);
            return;
        }
        this.recoverFromFailure = false;
        if (inventory.length === 0) return;
        // make sure we only have 5 outgoing trade offers max to one account
        const numItemsToSend = Math.max(50, Math.ceil(inventory.length / 5.0));
        const chunkedItems = Bot.chunkArray(inventory, numItemsToSend);
        const target = this.getTarget();
        console.log(`${this.tag} ${chunkedItems.length} groups of ${numItemsToSend} items will be sent to ${target}.`);
        chunkedItems.forEach((items, i) => {
            const offer = this.manager.createOffer(target);
            items.forEach(item => offer.addMyItem(item));
            console.log(`${this.tag} Sending trade offer for group #${i + 1} of ${items.length} items.`);
            offer.send((sendErr) => {
                if (!sendErr) return;
                console.log(`${this.tag} ${sendErr}`);
                if (sendErr.toString().includes('You have sent too many trade offers')) {
                    this.cancelOutgoingTradeOffers();
                }
                this.recoverFromFailure = true;
            });
        });
    }

    async onNewOffer(offer) {
        if (offer.itemsToGive.length > 0) {
            offer.decline();
            console.log(`${this.tag} Declined trade offer from ${offer.partner.toString()} trying to take my items.`);
            return;
        }
        console.log(`${this.tag} Accepting trade offer with ${offer.itemsToReceive.length} items.`);
        await this.acceptOffer(offer);
        let receivedItems;
        try {
            console.log(`${this.tag} Fetching list of received items...`);
            receivedItems = await this.getReceivedItems(offer);
        } catch (err) {
            console.log(`${this.tag} Couldn't get list of received items from trade offer: ${err.toString()}`);
            this.recoverFromFailure = true;
            return;
        }
        // make sure we only have 5 outgoing trade offers max to one account
        const numItemsToSend = Math.max(50, Math.ceil(receivedItems.length / 5.0));
        const chunkedItems = Bot.chunkArray(receivedItems, numItemsToSend);
        const target = this.getTarget();
        console.log(`${this.tag} ${chunkedItems.length} groups of ${numItemsToSend} items will be sent to ${target}.`);
        chunkedItems.forEach((items, i) => {
            const sendOffer = this.manager.createOffer(target);
            items.forEach(item => sendOffer.addMyItem({
                assetid: item.new_assetid,
                appid: 730,
                contextid: 2,
            }));
            console.log(`${this.tag} Sending trade offer for group #${i + 1} of ${items.length} items.`);
            sendOffer.send((sendErr) => {
                if (!sendErr) return;
                console.log(`${this.tag} ${sendErr}`);
                if (sendErr.toString().includes('You have sent too many trade offers')) {
                    this.cancelOutgoingTradeOffers();
                }
                this.recoverFromFailure = true;
            });
        });
    }

    async getReceivedItems(offer, retries = 0) {
        return new Promise((resolve, reject) => {
            offer.getExchangeDetails(true, async (err, status, tradeInitTime, receivedItems) => {
                if (err) {
                    if (retries >= 5) {
                        return reject(err);
                    }
                    console.log(`${this.tag} Failed to get list of received items: ${err}. Trying again in ${(retries + 1) * 20} seconds.`);
                    await new Promise(resolve2 => setTimeout(resolve2, (retries + 1) * 20 * 1000));
                    return resolve(false);
                }
                if (status !== TradeOfferManager.ETradeStatus.Complete) {
                    if (status > TradeOfferManager.ETradeStatus.Complete || retries >= 3) {
                        return reject(status);
                    }
                    console.log(`${this.tag} Failed to get list of received items because status is ${TradeOfferManager.ETradeStatus[status]}. Trying again in one minute.`);
                    await new Promise(resolve2 => setTimeout(resolve2, 60 * 1000));
                    return resolve(false);
                }
                console.log(`${this.tag} Successfully fetched list of received items.`);
                return resolve(receivedItems);
            });
        }).then(receivedItems => receivedItems || this.getReceivedItems(offer, retries + 1));
    }

    async acceptOffer(offer, tries = 1) {
        return new Promise((resolve) => {
            offer.accept(true, async (err) => {
                if (!err) {
                    console.log(`${this.tag} Accepted trade offer #${offer.id} from ${offer.partner.toString()}.`);
                    return resolve(true);
                }
                // retry accept until successful
                const minToWait = err.toString().includes('(16)') ? 15 : tries;
                if (tries === 3) {
                    console.log(`${this.tag} Failed to accept trade offer after 3 tries (might have been accepted already).`);
                    return resolve(true);
                }
                console.log(`${this.tag} Error accepting trade offer #${offer.id} from ${offer.partner.toString()}. Trying again in ${minToWait} minutes.`);
                await new Promise(resolve2 => setTimeout(resolve2, minToWait * 60 * 1000));
                return resolve(false);
            });
        }).then(success => (success ? Promise.resolve() : this.acceptOffer(offer, tries + 1)));
    }

    login() {
        return new Promise((resolve, reject) => {
            const code = this.generateAuthCode();
            console.log(`${this.tag} Using 2FA code "${code}".`);
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
        if (this.isRetryingLogin) return Promise.resolve();
        this.isRetryingLogin = true;
        console.log(`${this.tag} Logging into Steam Community website...`);
        for (let i = 0; i < 3; i++) {
            try {
                const cookies = await this.login();
                await this.setCookies(cookies);
                console.log(`${this.tag} Successfully logged in!`);
                this.isRetryingLogin = false;
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
        this.isRetryingLogin = false;
        return this.retryLogin();
    }
    /* eslint-enable no-await-in-loop */

    generateAuthCode() {
        return SteamTotp.generateAuthCode(this.config.shared_secret);
    }

    setCookies(cookies) {
        return new Promise((resolve, reject) => {
            this.manager.setCookies(cookies, null, (err) => {
                if (err) return reject(err);
                return resolve();
            });
        });
    }

    getTarget() {
        if (Array.isArray(this.config.target)) {
            if (this.config.target.length === 0) {
                return '';
            }
            // return random element from array
            return this.config.target[Math.floor(Math.random() * this.config.target.length)];
        }
        return this.config.target;
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
