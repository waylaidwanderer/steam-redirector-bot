module.exports = {
    "extends": "airbnb-base",
    "plugins": [
        "import"
    ],
    "rules": {
        "linebreak-style": 0,
        "no-console": 0,
        "no-use-before-define": ["error", "nofunc"],
        "indent": ["error", 4],
        "arrow-parens": [2, "as-needed", { "requireForBlockBody": true }],
        "no-plusplus": ["error", { "allowForLoopAfterthoughts": true }]
    }
};