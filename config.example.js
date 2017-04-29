module.exports = [
    {
        username: '',
        password: '',
        shared_secret: '',
        identity_secret: '',
        target: '', // Can be a SteamID or trade url
        proxy: '', // Optional
    }, // create a copy of this object if you want to run multiple bots, like so:
    {
        username: '',
        password: '',
        shared_secret: '',
        identity_secret: '',
        target: ['SteamID', 'trade url', 'trade url', 'etc'], // This can also be an array. A random one will be selected each time a trade offer is sent.
        proxy: '', // Optional
    },
];
